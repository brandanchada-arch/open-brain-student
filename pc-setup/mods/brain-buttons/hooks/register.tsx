import type { Register } from 'claude-code'

// Runs the session-save script from the Open Brain PC setup, wherever the home folder is.
const SAVE = "require(require('os').homedir()+'/.open-brain/scripts/session-save.js').cli(process.argv[1])"
// No background at rest, light green under the pointer.
const HOVER = { backgroundColor: '#86efac' }

// The two letters, small circled letters.
const dots = (els: any, id: string, save: () => void, prompt: () => void, important: () => void) => {
  const { Box, Button, Text } = els
  return (
    <Box flexDirection="row">
      <Box key={`${id}-s`} hover={HOVER}><Button key={`${id}-save`} label="Ⓢ" plain dimColor onPress={save} /></Box>
      <Text> </Text>
      <Box key={`${id}-p`} hover={HOVER}><Button key={`${id}-prompt`} label="Ⓟ" plain dimColor onPress={prompt} /></Box>
      <Text> </Text>
      <Box key={`${id}-i`} hover={HOVER}><Button key={`${id}-important`} label="Ⓘ" plain dimColor onPress={important} /></Box>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'done', description: 'Save a summary of this chat to your brain' })
    return next(e)
  })

  on('command.run', { command: 'done' }, async $ => {
    const { exitCode, stdout } = await $.process.run(['node', '-e', SAVE, await $.session.id()])
    const message = String(stdout ?? '').trim()
    return { text: exitCode === 0 && message ? message : 'The summary could not be saved.' }
  })

  // The band above the message box. It's the one spot near the box that the desktop app shows.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    return dots(
      $.ui.resolve(e), 'band',
      async () => {
        $.ui.status('Saving summary...')
        const { exitCode, stdout } = await $.process.run(['node', '-e', SAVE, await $.session.id()])
        $.ui.status(undefined)
        $.ui.toast(exitCode === 0 && String(stdout ?? '').trim() ? String(stdout).trim() : 'The summary could not be saved.')
      },
      () => void $.prompt.submit({ text: '/prompt' }),
      async () => void $.prompt.submit({ text: `/important ${await $.session.id()}` }),
    )
  })
}
