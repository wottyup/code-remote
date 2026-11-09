const { spawnSync } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

async function packageWindowsInstaller() {
  const desktopDirectory = __dirname
  const packageMetadata = JSON.parse(await fs.readFile(path.join(desktopDirectory, 'package.json'), 'utf8'))
  const outputDirectory = path.resolve(desktopDirectory, packageMetadata.build.directories.output)
  const installerName = `Code-Remote-Desktop-${packageMetadata.version}-x64.exe`
  const installerPath = path.join(outputDirectory, installerName)

  try {
    await fs.access(installerPath)
    throw new Error(`Refusing to overwrite existing installer: ${installerPath}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const buildDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'code-remote-desktop-build-'))
  try {
    for (const filename of ['main.cjs', 'preload-shell.cjs', 'preload-remote.cjs']) {
      await fs.copyFile(path.join(desktopDirectory, filename), path.join(buildDirectory, filename))
    }
    await fs.cp(path.join(desktopDirectory, 'renderer'), path.join(buildDirectory, 'renderer'), { recursive: true })
    await fs.mkdir(path.join(buildDirectory, 'node_modules'))

    packageMetadata.devDependencies.electron = require('electron/package.json').version
    packageMetadata.build.directories.output = outputDirectory
    await fs.writeFile(path.join(buildDirectory, 'package.json'), JSON.stringify(packageMetadata, null, 2))

    const builderCli = require.resolve('electron-builder/out/cli/cli.js')
    const result = spawnSync(process.execPath, [builderCli, '--win', 'nsis', '--x64'], {
      cwd: buildDirectory,
      stdio: 'inherit',
      env: process.env,
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`electron-builder exited with status ${result.status}`)
  } finally {
    await fs.rm(buildDirectory, { recursive: true, force: true })
  }
}

packageWindowsInstaller().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
