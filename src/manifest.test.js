import manifest from './manifest.json'

describe('Manifest V3 Compatibility', () => {
  test('should be Manifest V3', () => {
    expect(manifest.manifest_version).toBe(3)
  })

  test('should use action instead of browser_action', () => {
    expect(manifest.action).toBeDefined()
    expect(manifest.browser_action).toBeUndefined()
    expect(manifest.page_action).toBeUndefined()
  })

  test('should use service_worker for background', () => {
    expect(manifest.background).toBeDefined()
    expect(manifest.background.service_worker).toBeDefined()
    expect(manifest.background.scripts).toBeUndefined()
  })

  test('should have host_permissions separate from permissions', () => {
    expect(manifest.host_permissions).toBeDefined()
    expect(manifest.host_permissions).toContain('<all_urls>')
  })

  test('should not have webRequestBlocking permission', () => {
    expect(manifest.permissions).not.toContain('webRequestBlocking')
  })

  test('should have declarativeNetRequest permissions', () => {
    expect(manifest.permissions).toContain('declarativeNetRequest')
  })

  test('should have required permissions', () => {
    expect(manifest.permissions).toContain('storage')
    expect(manifest.permissions).toContain('tabs')
  })
})
