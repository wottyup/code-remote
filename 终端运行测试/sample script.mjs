console.log('script_type=node-mjs')
console.log(`script_path=${new URL(import.meta.url).pathname}`)
console.log(`working_directory=${process.cwd()}`)
console.log('status=ok')
