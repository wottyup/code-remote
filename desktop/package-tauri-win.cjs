const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const desktopRoot = __dirname
const projectRoot = path.resolve(desktopRoot, '..')
const desktopPackage = require('./package.json')
const target = process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : 'x86_64-pc-windows-gnu'
const outputDirectory = path.join(projectRoot, 'artifacts', 'desktop')
const outputName = `Code-Remote-Desktop-${desktopPackage.version}-x64.exe`
const outputPath = path.join(outputDirectory, outputName)

async function main() {
  if (fs.existsSync(outputPath)) {
    throw new Error(`Refusing to overwrite the existing installer: ${outputPath}`)
  }

  const cli = path.join(desktopRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri')
  if (!fs.existsSync(cli)) throw new Error('Tauri CLI is missing. Install workspace dependencies first.')

  const build = spawnSync(cli, ['build', '--target', target, '--bundles', 'nsis'], {
    cwd: desktopRoot,
    env: { ...process.env },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (build.error) throw build.error
  if (build.status !== 0) throw new Error(`Tauri build failed with exit code ${build.status}.`)

  const bundleDirectory = path.join(desktopRoot, 'src-tauri', 'target', target, 'release', 'bundle', 'nsis')
  const installers = (await fsp.readdir(bundleDirectory))
    .filter((name) => name.includes(desktopPackage.version) && name.toLowerCase().endsWith('.exe'))
    .map((name) => path.join(bundleDirectory, name))
  if (installers.length !== 1) {
    throw new Error(`Expected one NSIS installer in ${bundleDirectory}; found ${installers.length}.`)
  }

  await fsp.mkdir(outputDirectory, { recursive: true })
  await fsp.copyFile(installers[0], outputPath, fs.constants.COPYFILE_EXCL)
  const { size } = await fsp.stat(outputPath)
  console.log(`Created ${outputPath} (${(size / 1024 / 1024).toFixed(1)} MiB).`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
