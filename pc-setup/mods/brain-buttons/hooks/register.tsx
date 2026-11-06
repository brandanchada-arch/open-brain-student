import type { Register } from 'claude-code'

// Runs the session-save script from the Open Brain PC setup, wherever the home folder is.
const SAVE = "require(require('os').homedir()+'/.open-brain/scripts/session-save.js').cli(process.argv[1])"

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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box>
        <Button
          key="save"
          label="Save summary"
          onPress={async () => {
            $.ui.toast("Saving this chat's summary...")
            const { exitCode, stdout } = await $.process.run(['node', '-e', SAVE, await $.session.id()])
            const message = String(stdout ?? '').trim()
            $.ui.toast(exitCode === 0 && message ? message : 'The summary could not be saved.')
          }}
        />
        <Button key="prompt" label="Make a prompt" onPress={() => void $.prompt.submit({ text: '/prompt' })} />
      </Box>
    )
  })
}
