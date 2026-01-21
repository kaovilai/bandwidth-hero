import shouldCompress from './background/shouldCompress'
import patchContentSecurity from './background/patchContentSecurity'
import getHeaderValue from './background/getHeaderIntValue'
import parseUrl from './utils/parseUrl'
import deferredStateStorage from './utils/deferredStateStorage'
import defaultState from './defaults'
import isPrivateNetwork from './background/isPrivateNetwork';
// Note: axios dependency removed as it was only used in MV2 for Firefox HEAD requests
// which are not supported in the MV3 non-blocking webRequest implementation

// Handle update from previous versions
chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  if (reason === 'update') {
    chrome.storage.local.get(storedState => {
      try {
        // Load update script if it exists for this version
        import(`./updates/${previousVersion}.js`).then(module => {
          module.default(storedState)
        }).catch(() => {})
      } catch (e) {}
    })
  }
  onInstalled()
})

// Service worker - all initialization must be at top level
const storage = deferredStateStorage()
const compressed = new Set();
let setupHasBeenOpened = false;
let state = { ...defaultState };
let currentPageUrl = null;
let currentPageProtocol = null;

// Initialize state from storage
chrome.storage.local.get(storedState => {
    state = { ...defaultState, ...storedState };

    if (/compressor\.bandwidth-hero\.com/i.test(storedState.proxyUrl)) {
        chrome.storage.local.set({ ...storedState, proxyUrl: '' })
    }

    checkWebpSupport().then(isSupported => {
        chrome.storage.local.set({ ...storedState, isWebpSupported: isSupported })
    })
})

async function checkWebpSupport() {
    if (!self.createImageBitmap) return false
    const webpData = 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA='
    const blob = await fetch(webpData).then(r => r.blob())
    return self.createImageBitmap(blob).then(() => true, () => false)
}

/**
 * Sets the icons based on the disabled parameter.
 */
function setIcon() {
    const isEnabled = state.enabled && !isDisabledSite();
    if (chrome.action && chrome.action.setIcon) {
        chrome.action.setIcon({
            path: isEnabled ? "assets/icon-128.png" : "assets/icon-128-disabled.png"
        });
    }
}

/**
 * Checks if the proxy is disabled for the given url
 * @returns {boolean}
 */
function isDisabledSite() {
    // If we don't have the URL or protocol we can't check if it is enabled.
    if (!currentPageUrl || !currentPageProtocol) {
        return true;
    }

    // Check if the page is a http/https page.
    const supportedProtocols = ['http:', 'https:'];
    if (!supportedProtocols.includes(currentPageProtocol)) {
        return true;
    }

    // We are disabled when on localhost or site is hosted on private IP.
    if (isPrivateNetwork(currentPageUrl)) {
        return true;
    }
    return state.disabledHosts.includes(currentPageUrl);
}

/**
 * Every time the storage of the browser changes we also update our in-memory state to keep up with the changes.
 *
 */
function onStateChanged(changes) {
    const changedItems = Object.keys(changes);
    for (const item of changedItems) {
        if (state[item] !== changes[item].newValue) {
            state[item] = changes[item].newValue;
            stateItemChanged(item, state[item]);
        }
    }
}

/**
 * Perform actions for certain changes to the state. Like changing the icon if we enable/disable the extension.
 * @param key
 * @param newValue
 */
function stateItemChanged(key, newValue) {
    switch (key) {
        case 'enabled':
        case 'disabledHosts':
            setIcon(); // Update icon
            break;
    }
}

function checkSetup() {
    if (!state.enabled) return;
    if (setupHasBeenOpened) return;
    if (state.proxyUrl === '' || /compressor\.bandwidth-hero\.com/i.test(state.proxyUrl)) {
        chrome.tabs.create({ url: 'setup.html' });
        setupHasBeenOpened = true;
    }
}

function onInstalled() {
    checkSetup();
}

/**
 * Intercept image loading request and decide if we need to compress it.
 * NOTE: In Manifest V3, blocking webRequest is very limited.
 * This extension requires dynamic redirects based on runtime state,
 * which is not fully supported in MV3's declarativeNetRequest.
 * 
 * For now, we use non-blocking observation and log the behavior.
 * A full solution would require content scripts to intercept image loads
 * or accepting the MV3 limitations.
 */
function onBeforeRequestListener({ url, documentUrl, type }) {
    checkSetup();

    const pageUrl = currentPageUrl || parseUrl(documentUrl).host;

    if (
        shouldCompress({
            imageUrl: url,
            pageUrl,
            compressed,
            proxyUrl: state.proxyUrl,
            disabledHosts: state.disabledHosts,
            enabled: state.enabled,
            type
        })
    ) {
        compressed.add(url)
        // MV3 limitation: Can't perform dynamic redirect here
        // This would need to be handled via declarativeNetRequest with dynamic rules
        // or via content scripts
    }
}

/**
 * Retrieve saved bytes info from response headers, update statistics in
 * app storage and notify UI about state changes.
 */
function onCompletedListener({ responseHeaders, fromCache }) {
    if (fromCache) return;
    const bytesSaved = getHeaderValue(responseHeaders, 'x-bytes-saved')
    const bytesProcessed = getHeaderValue(responseHeaders, 'x-original-size')
    if (bytesSaved !== false && bytesProcessed !== false) {
        state.statistics.filesProcessed += 1
        state.statistics.bytesProcessed += bytesProcessed
        state.statistics.bytesSaved += bytesSaved

        storage.set({statistics : state.statistics})
    }
}

function onTabActivated({tabId}) {
    chrome.tabs.get(tabId, tab => {
        if (tab && tab.url) {
            const url = parseUrl(tab.url);
            currentPageUrl = url.hostname;
            currentPageProtocol = url.schema;
            compressed.clear(); // Reset our list of compressed images
            setIcon();
        }
    });
}

// If we navigate to a new page within a tab and it is the same we have a
// bug where it does not process images. Because the images are still in
// compressed even though the page changed. With onTabUpdated we reset this.
function onTabUpdated(){
  compressed.clear()
}

/**
 * Patch document's content security policy headers so that it will allow
 * images loading from our compression proxy URL.
 * 
 * NOTE: In Manifest V3, modifying headers with blocking webRequest is restricted.
 * This may not work in all scenarios. Consider using declarativeNetRequest
 * for production.
 */
function onHeadersReceivedListener({ responseHeaders }) {
    if (!state.proxyUrl) {
        return {}
    }
    return {
        responseHeaders: patchContentSecurity(responseHeaders, state.proxyUrl)
    }
}

/**
 * Firefox user agent check
 * Must be defined before listener registration
 */
function isFirefox() {
    return /rv\:.*Gecko/.test(self.navigator.userAgent)
}

/**
 * Builds up a redirect URL for image compression.
 * NOTE: In MV3, this function is not actively used due to blocking webRequest limitations.
 * Kept for reference and potential future use with declarativeNetRequest.
 * @param url - Original image URL
 * @returns {string} - Compression proxy URL with parameters
 */
function buildCompressUrl(url) {
    let redirectUrl = '';
    redirectUrl += state.proxyUrl;
    redirectUrl += `?url=${encodeURIComponent(url)}`;
    redirectUrl += `&jpeg=${state.isWebpSupported ? 0 : 1}`;
    redirectUrl += `&bw=${state.convertBw ? 1 : 0}`;
    redirectUrl += `&l=${state.compressionLevel}`;
    return redirectUrl;
}

// Register all listeners at top level (required for service workers)
// MV3 limitation: Cannot use blocking webRequest for image redirects
// This listener is non-blocking and only used for observation
chrome.webRequest.onBeforeRequest.addListener(
    onBeforeRequestListener,
    {
        urls: ['<all_urls>'],
        types: isFirefox() ? ['xmlhttprequest', 'imageset', 'image'] : ['image']
    }
)

chrome.webRequest.onCompleted.addListener(
    onCompletedListener,
    {
        urls: ['<all_urls>'],
        types: isFirefox() ? ['xmlhttprequest', 'imageset', 'image'] : ['image']
    },
    ['responseHeaders']
)

// MV3: This may have limited functionality compared to MV2
chrome.webRequest.onHeadersReceived.addListener(
    onHeadersReceivedListener,
    {
        urls: ['<all_urls>'],
        types: ['main_frame', 'sub_frame']
    },
    ['blocking', 'responseHeaders']
)

chrome.tabs.onActivated.addListener(onTabActivated)

chrome.tabs.onUpdated.addListener(onTabUpdated)

chrome.storage.onChanged.addListener(onStateChanged)
