export function filterSidebarThreads(threads, engineFilter = null, search = '') {
  const normalizedSearch = search.trim().toLocaleLowerCase()
  return threads.filter((thread) => {
    const engine = thread.engine === 'claude-code' ? 'claude-code' : 'codex'
    if (engineFilter && engine !== engineFilter) return false
    if (!normalizedSearch) return true
    return [thread.name, thread.preview]
      .some((value) => value?.toLocaleLowerCase().includes(normalizedSearch))
  })
}
