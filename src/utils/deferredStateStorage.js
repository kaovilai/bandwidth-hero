export default (delay = 1000) => {
  let pendingState = null
  let timerId

  return {
    set(state) {
      if (pendingState === null) {
        timerId = self.setTimeout(() => {
          chrome.storage.local.set(pendingState, () => {
            self.clearTimeout(timerId)
            pendingState = null
          })
        }, delay)
      }

      pendingState = state
    }
  }
}
