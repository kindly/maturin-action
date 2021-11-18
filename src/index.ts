import * as core from '@actions/core'
import * as httpclient from '@actions/http-client'
import {promises as fs, writeFileSync, existsSync} from 'fs'
import * as tc from '@actions/tool-cache'
import * as exec from '@actions/exec'
import * as io from '@actions/io'
import * as path from 'path'
import stringArgv from 'string-argv'

import * as mexec from './exec'

const IS_MACOS = process.platform === 'darwin'
const IS_WINDOWS = process.platform === 'win32'
const IS_LINUX = process.platform === 'linux'
const DEFAULT_MATURIN_VERSION = 'v0.11.5'

const DEFAULT_TARGET: Record<string, string> = {
  x64: 'x86_64-unknown-linux-gnu',
  arm64: 'aarch64-unknown-linux-gnu'
}

const DEFAULT_CONTAINERS: Record<string, Record<string, string>> = {
  'x86_64-unknown-linux-gnu': {
    auto: 'quay.io/pypa/manylinux2010_x86_64:latest',
    '2010': 'quay.io/pypa/manylinux2010_x86_64:latest',
    '2_12': 'quay.io/pypa/manylinux2010_x86_64:latest',
    '2014': 'quay.io/pypa/manylinux2014_x86_64:latest',
    '2_17': 'quay.io/pypa/manylinux2014_x86_64:latest',
    '2_24': 'quay.io/pypa/manylinux_2_24_x86_64:latest'
  },
  'x86_64-unknown-linux-musl': {
    auto: 'messense/rust-musl-cross:x86_64-musl',
    musllinux_1_2: 'messense/rust-musl-cross:x86_64-musl'
  },
  'i686-unknown-linux-gnu': {
    auto: 'quay.io/pypa/manylinux2010_i686:latest',
    '2010': 'quay.io/pypa/manylinux2010_i686:latest',
    '2_12': 'quay.io/pypa/manylinux2010_i686:latest',
    '2014': 'quay.io/pypa/manylinux2014_i686:latest',
    '2_17': 'quay.io/pypa/manylinux2014_i686:latest',
    '2_24': 'quay.io/pypa/manylinux_2_24_i686:latest'
  },
  'i686-unknown-linux-musl': {
    auto: 'messense/rust-musl-cross:i686-musl',
    musllinux_1_2: 'messense/rust-musl-cross:i686-musl'
  },
  'aarch64-unknown-linux-gnu': {
    auto: 'messense/manylinux2014-cross:aarch64',
    '2014': 'messense/manylinux2014-cross:aarch64',
    '2_17': 'messense/manylinux2014-cross:aarch64',
    '2_24': 'messense/manylinux_2_24-cross:aarch64'
  },
  'aarch64-unknown-linux-musl': {
    auto: 'messense/rust-musl-cross:aarch64-musl',
    musllinux_1_2: 'messense/rust-musl-cross:aarch64-musl'
  },
  'armv7-unknown-linux-gnueabihf': {
    auto: 'messense/manylinux2014-cross:armv7',
    '2014': 'messense/manylinux2014-cross:armv7',
    '2_17': 'messense/manylinux2014-cross:armv7',
    '2_24': 'messense/manylinux_2_24-cross:armv7'
  },
  'armv7-unknown-linux-musleabihf': {
    auto: 'messense/rust-musl-cross:armv7-musleabihf',
    musllinux_1_2: 'messense/rust-musl-cross:armv7-musleabihf'
  },
  'powerpc64-unknown-linux-gnu': {
    auto: 'messense/manylinux2014-cross:ppc64',
    '2014': 'messense/manylinux2014-cross:ppc64',
    '2_17': 'messense/manylinux2014-cross:ppc64'
  },
  'powerpc64le-unknown-linux-gnu': {
    auto: 'messense/manylinux2014-cross:ppc64le',
    '2014': 'messense/manylinux2014-cross:ppc64le',
    '2_17': 'messense/manylinux2014-cross:ppc64le',
    '2_24': 'messense/manylinux_2_24-cross:ppc64le'
  },
  'powerpc64le-unknown-linux-musl': {
    auto: 'messense/rust-musl-cross:powerpc64le-musl',
    musllinux_1_2: 'messense/rust-musl-cross:powerpc64le-musl'
  },
  's390x-unknown-linux-gnu': {
    auto: 'messense/manylinux2014-cross:s390x',
    '2014': 'messense/manylinux2014-cross:s390x',
    '2_17': 'messense/manylinux2014-cross:s390x',
    '2_24': 'messense/manylinux_2_24-cross:s390x'
  }
}

const DEFAULT_CONTAINER = DEFAULT_CONTAINERS[DEFAULT_TARGET[process.arch]]

/**
 * Rust target aliases by platform
 */
const TARGET_ALIASES: Record<string, Record<string, string>> = {
  darwin: {
    x64: 'x86_64-apple-darwin',
    x86_64: 'x86_64-apple-darwin',
    aarch64: 'aarch64-apple-darwin'
  },
  linux: {
    x64: 'x86_64-unknown-linux-gnu',
    x86_64: 'x86_64-unknown-linux-gnu',
    i686: 'i686-unknown-linux-gnu',
    x86: 'i686-unknown-linux-gnu',
    aarch64: 'aarch64-unknown-linux-gnu',
    armv7: 'armv7-unknown-linux-gnueabihf',
    armv7l: 'armv7-unknown-linux-gnueabihf',
    ppc64le: 'powerpc64le-unknown-linux-gnu',
    ppc64: 'powerpc64-unknown-linux-gnu',
    s390x: 's390x-unknown-linux-gnu'
  },
  win32: {
    x64: 'x86_64-pc-windows-msvc',
    x86_64: 'x86_64-pc-windows-msvc',
    i686: 'i686-pc-windows-msvc',
    x86: 'i686-pc-windows-msvc',
    aarch64: 'aarch64-pc-windows-msvc'
  }
}

/**
 * Get Rust target full name
 */
function getRustTarget(): string {
  const target = core.getInput('target')
  return TARGET_ALIASES[process.platform]?.[target] || target
}

/**
 * Find maturin version
 */
async function findVersion(): Promise<string> {
  const version = core.getInput('maturin-version')
  if (version !== 'latest') {
    if (!version.startsWith('v')) {
      core.warning(
        `Corrected 'maturin-version' from '${version}' to 'v${version}'`
      )
      return `v${version}`
    }
    return version
  }

  core.debug('Searching the latest version of maturin ...')
  const http = new httpclient.HttpClient('messense/maturin-action', [], {
    allowRetries: true,
    maxRetries: 10
  })
  const response = await http.get(
    'https://api.github.com/repos/PyO3/maturin/releases/latest'
  )
  const body = await response.readBody()
  let tag = JSON.parse(body).tag_name
  if (!tag) {
    // Just in case fetch latest maturin version failed
    tag = DEFAULT_MATURIN_VERSION
    core.warning(`Fetch latest maturin tag name failed, fallback to '${tag}'`)
  }
  return Promise.resolve(tag)
}

/**
 * Download and return the path to an executable maturin tool
 * @param string tag The tag to download
 */
async function downloadMaturin(tag: string): Promise<string> {
  let name: string
  let zip = false
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  if (IS_WINDOWS) {
    name = `maturin-${arch}-pc-windows-msvc.zip`
    zip = true
  } else if (IS_MACOS) {
    name = `maturin-${arch}-apple-darwin.tar.gz`
  } else {
    name = `maturin-${arch}-unknown-linux-musl.tar.gz`
  }
  const url = `https://github.com/PyO3/maturin/releases/download/${tag}/${name}`
  const tool = await tc.downloadTool(url)
  let toolPath: string
  if (zip) {
    toolPath = await tc.extractZip(tool)
  } else {
    toolPath = await tc.extractTar(tool)
  }

  let exe: string
  if (!IS_WINDOWS) {
    exe = path.join(toolPath, 'maturin')
    await fs.chmod(exe, 0o755)
  } else {
    exe = path.join(toolPath, 'maturin.exe')
  }
  return Promise.resolve(exe)
}

async function installMaturin(tag: string): Promise<string> {
  try {
    const exe = await io.which('maturin', true)
    core.info(`Found 'maturin' at ${exe}`)
    return exe
  } catch (error) {
    const exe = await downloadMaturin(tag)
    core.info(`Installed 'maturin' to ${exe}`)
    core.addPath(path.dirname(exe))
    return exe
  }
}

/**
 * Build manylinux wheel using Docker
 * @param tag maturin release tag, ie. version
 * @param args Docker args
 */
async function dockerBuild(tag: string, args: string[]): Promise<number> {
  // Strip `manylinux` and `manylinx_` prefix
  const manylinux = core.getInput('manylinux').replace(/^manylinux_?/, '')
  const target = getRustTarget()
  let container = core.getInput('container')
  if (container.length === 0) {
    // Get default Docker container with fallback
    container =
      DEFAULT_CONTAINERS[target]?.[manylinux] || DEFAULT_CONTAINER[manylinux]
  }

  const dockerArgs = []
  let image: string
  if (container.includes(':') || !container.startsWith('konstin2/maturin')) {
    image = container
  } else {
    // konstin2/maturin support
    image = `${container}:${tag}`
    // override entrypoint
    dockerArgs.push('--entrypoint', '/bin/bash')
  }

  core.startGroup('Pull Docker image')
  core.info(`Using ${image} Docker image`)
  const exitCode = await exec.exec('docker', ['pull', image])
  if (exitCode !== 0) {
    throw new Error(`maturin: 'docker pull' returned ${exitCode}`)
  }
  core.endGroup()

  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  const url = `https://github.com/PyO3/maturin/releases/download/${tag}/maturin-${arch}-unknown-linux-musl.tar.gz`
  // Defaults to stable for Docker build
  const rustToolchain = core.getInput('rust-toolchain') || 'stable'
  const commands = [
    '#!/bin/bash',
    // Stop on first error
    'set -e',
    // Install Rust
    'echo "::group::Install Rust"',
    `which rustup > /dev/null || curl --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain ${rustToolchain}`,
    'export PATH="$HOME/.cargo/bin:$PATH"',
    `rustup override set ${rustToolchain}`,
    'echo "::endgroup::"',
    // Add all supported python versions to PATH
    'export PATH="$PATH:/opt/python/cp36-cp36m/bin:/opt/python/cp37-cp37m/bin:/opt/python/cp38-cp38/bin:/opt/python/cp39-cp39/bin"',
    // Install maturin
    'echo "::group::Install maturin"',
    `curl -L ${url} | tar -xz -C /usr/local/bin`,
    'maturin --version',
    'echo "::endgroup::"'
  ]
  if (target.length > 0) {
    commands.push(
      'echo "::group::Install Rust target"',
      `if [[ ! -d $(rustc --print target-libdir --target ${target}) ]]; then rustup target add ${target}; fi`,
      'echo "::endgroup::"'
    )
  }

  commands.push(core.getInput('extra-build-command'))

  commands.push(`maturin ${args.join(' ')}`)

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const workspace = process.env.GITHUB_WORKSPACE!
  const scriptPath = path.join(workspace, 'run-maturin-action.sh')
  process.stdout.write(commands.join('\n'))
  writeFileSync(scriptPath, commands.join('\n'))
  await fs.chmod(scriptPath, 0o755)

  return await exec.exec('docker', [
    'run',
    '--rm',
    '--workdir',
    workspace,
    // A list of environment variables
    '-e',
    'DEBIAN_FRONTEND=noninteractive',
    '-e',
    'RUSTFLAGS',
    '-e',
    'RUST_BACKTRACE',
    '-e',
    'MATURIN_PASSWORD',
    '-e',
    'MATURIN_PYPI_TOKEN',
    '-e',
    'ARCHFLAGS',
    '-e',
    'PYO3_CROSS',
    '-e',
    'PYO3_CROSS_LIB_DIR',
    '-e',
    'PYO3_CROSS_PYTHON_VERSION',
    '-e',
    '_PYTHON_SYSCONFIGDATA_NAME',
    // Mount $GITHUB_WORKSPACE at the same path
    '-v',
    `${workspace}:${workspace}`,
    ...dockerArgs,
    image,
    scriptPath
  ])
}

/**
 * Install Rust target using rustup
 * @param target Rust target name
 */
async function installRustTarget(
  target: string,
  toolchain: string
): Promise<void> {
  if (!target || target.length === 0) {
    return
  }
  const args = ['--print', 'target-libdir', '--target', target]
  if (toolchain.length > 0) {
    args.unshift(`+${toolchain}`)
  }
  const res = await mexec.exec('rustc', args, true)
  if (res.stderr !== '' && !res.success) {
    throw new Error(res.stderr)
  } else if (existsSync(res.stdout.trim())) {
    // Target already installed
    return
  }
  if (toolchain.length > 0) {
    await exec.exec('rustup', [
      'target',
      'add',
      '--toolchain',
      toolchain,
      target
    ])
  } else {
    await exec.exec('rustup', ['target', 'add', target])
  }
}

async function addToolCachePythonVersionsToPath(): Promise<void> {
  const allPythonVersions = tc.findAllVersions('python')
  for (const ver of allPythonVersions) {
    const installDir = tc.find('Python', ver)
    if (installDir) {
      core.info(`Python version ${ver} was found in the local cache`)
      core.addPath(installDir)
      core.addPath(path.join(installDir, 'bin'))
    }
  }
}

async function innerMain(): Promise<void> {
  const rustToolchain = core.getInput('rust-toolchain')
  const inputArgs = core.getInput('args')
  const args = stringArgv(inputArgs)
  const command = core.getInput('command')
  args.unshift(command)

  let useDocker = false
  // Only build and publish commands has --manylinux and --target options
  if (['build', 'publish'].includes(command)) {
    const manylinux = core.getInput('manylinux').replace(/^manylinux_?/, '')
    if (manylinux.length > 0 && IS_LINUX) {
      if (manylinux !== 'auto') {
        // Use lowest compatible manylinux version
        args.push('--manylinux', manylinux)
      }
      // User can disable Docker build by set manylinux/container to off
      useDocker = manylinux !== 'off' && core.getInput('container') !== 'off'
    }

    const target = getRustTarget()
    if (target.length > 0) {
      args.push('--target', target)
    }
    if (!useDocker) {
      core.startGroup('Install Rust target')
      if (rustToolchain.length > 0) {
        await exec.exec('rustup', ['override', 'set', rustToolchain])
      }
      await installRustTarget(target, rustToolchain)
      core.endGroup()
    }
  }

  const tag = await findVersion()

  let exitCode: number
  if (useDocker) {
    exitCode = await dockerBuild(tag, args)
  } else {
    if (IS_MACOS && !process.env.pythonLocation) {
      addToolCachePythonVersionsToPath()
    }

    core.startGroup('Install maturin')
    core.info(`Installing 'maturin' from tag '${tag}'`)
    const maturinPath = await installMaturin(tag)
    await exec.exec(maturinPath, ['--version'])
    core.endGroup()

    // Setup additional env vars for macOS universal2 build
    const isUniversal2 = args.includes('--universal2')
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) {
        env[k] = v
      }
    }
    if (isUniversal2) {
      core.startGroup('Prepare macOS universal2 build environment')
      await installRustTarget('x86_64-apple-darwin', rustToolchain)
      await installRustTarget('aarch64-apple-darwin', rustToolchain)
      env.DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer'
      env.SDKROOT =
        '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk'
      env.MACOSX_DEPLOYMENT_TARGET = '10.9'
      core.endGroup()
    }
    const fullCommand = `${maturinPath} ${args.join(' ')}`
    exitCode = await exec.exec(fullCommand, undefined, {env})
  }
  if (exitCode !== 0) {
    throw new Error(`maturin: returned ${exitCode}`)
  }
}

async function main(): Promise<void> {
  try {
    await innerMain()
  } catch (error) {
    core.setFailed(error.message)
  }
}

main()
