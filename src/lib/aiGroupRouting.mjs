const canonicalEngineNames = {
  codex: ['Codex'],
  'claude-code': ['Claude Code', 'Claude'],
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchNameAtStart(prompt, name) {
  const normalizedName = name.trim().replace(/\s+/g, ' ')
  if (!normalizedName) return null
  const namePattern = normalizedName.split(' ').map(escapeRegExp).join('\\s+')
  const pattern = new RegExp(`^\\s*[@#]?\\s*${namePattern}(?=$|[\\s,:：，、.!?！？;；\\-—]|切换|切到|换成|换到|改成|改为|改用|调整|调高|调低|提高|降低|设置|模型|思考|推理|使用|采用|选择|用|请|帮|你)`, 'iu')
  const match = pattern.exec(prompt)
  if (!match) return null
  return {
    matchedName: normalizedName,
    length: match[0].length,
    remainder: prompt.slice(match[0].length).replace(/^[\s,，:：、.!?！？;；\-—]+/u, ''),
  }
}

/**
 * Route a leading member name to one group member. Canonical engine names
 * remain valid aliases after the user changes the display name.
 */
export function findGroupRecipient(prompt, group) {
  const perEngine = ['codex', 'claude-code'].flatMap((engine) => {
    const displayName = engine === 'codex' ? group.codexName : group.claudeName
    const names = [...new Set([displayName, ...canonicalEngineNames[engine]])]
    const matches = names
      .map((name) => matchNameAtStart(prompt, name))
      .filter(Boolean)
      .sort((left, right) => right.length - left.length)
    const match = matches[0]
    return match ? [{ engine, ...match }] : []
  })

  const longestLength = Math.max(0, ...perEngine.map((candidate) => candidate.length))
  const longestMatches = perEngine.filter((candidate) => candidate.length === longestLength)
  if (longestMatches.length > 1) return { ambiguous: true }
  const recipient = longestMatches[0]
  return recipient ? { engine: recipient.engine, matchedName: recipient.matchedName, remainder: recipient.remainder } : null
}
