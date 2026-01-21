export default url => {
  try {
    const parser = new URL(url)
    return {
      schema: parser.protocol,
      hostname: parser.hostname,
      port: parser.port,
      pathname: parser.pathname,
      search: parser.search,
      hash: parser.hash,
      host: parser.hostname
    }
  } catch (e) {
    // Fallback for invalid URLs
    return {
      schema: '',
      hostname: '',
      port: '',
      pathname: '',
      search: '',
      hash: '',
      host: ''
    }
  }
}
