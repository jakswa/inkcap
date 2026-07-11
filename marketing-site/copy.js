document.addEventListener('click', async (event) => {
  const button = event.target.closest('.copy-btn')
  if (!button) return

  const code = button.closest('.code-block')?.querySelector('code')
  if (!code) return

  try {
    await navigator.clipboard.writeText(code.textContent)
    button.textContent = 'Copied'
    button.dataset.state = 'copied'
  } catch {
    button.textContent = 'Copy failed'
    button.dataset.state = 'error'
  }

  clearTimeout(button.copyResetTimer)
  button.copyResetTimer = setTimeout(() => {
    button.textContent = 'Copy'
    delete button.dataset.state
  }, 1800)
})
