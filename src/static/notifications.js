(() => {
  const root = document.querySelector('[data-push-settings]')
  if (!root) return

  const publicKey = root.dataset.vapidPublicKey || ''
  const statusText = root.querySelector('[data-push-status-text]')
  const enableButton = root.querySelector('[data-push-enable]')
  const disableButton = root.querySelector('[data-push-disable]')
  const iosInstall = root.querySelector('[data-ios-install]')

  const setStatus = (text) => {
    if (statusText) statusText.textContent = text
  }

  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const isStandalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches

  if (isIos && !isStandalone && iosInstall) {
    iosInstall.classList.remove('hidden')
  }

  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    setStatus('This browser does not support Web Push.')
    if (enableButton) enableButton.disabled = true
    if (disableButton) disableButton.disabled = true
    return
  }

  if (!publicKey) {
    setStatus('Server VAPID keys are not configured.')
    return
  }

  const urlBase64ToUint8Array = (base64String) => {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
    const rawData = window.atob(base64)
    const outputArray = new Uint8Array(rawData.length)
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i)
    return outputArray
  }

  const registration = async () => navigator.serviceWorker.register('/sw.js')

  const refresh = async () => {
    try {
      const reg = await registration()
      const sub = await reg.pushManager.getSubscription()
      if (sub) setStatus('Enabled on this device.')
      else if (Notification.permission === 'denied') setStatus('Blocked by browser permission settings.')
      else setStatus('Not enabled on this device.')
    } catch (error) {
      setStatus(`Service worker setup failed: ${error.message || error}`)
    }
  }

  enableButton?.addEventListener('click', async () => {
    enableButton.disabled = true
    try {
      const reg = await registration()
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setStatus('Permission was not granted.')
        return
      }
      const existing = await reg.pushManager.getSubscription()
      const sub = existing || await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })
      const response = await fetch('/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub),
      })
      if (!response.ok) throw new Error(await response.text())
      setStatus('Enabled on this device.')
    } catch (error) {
      setStatus(`Could not enable notifications: ${error.message || error}`)
    } finally {
      enableButton.disabled = false
    }
  })

  disableButton?.addEventListener('click', async () => {
    disableButton.disabled = true
    try {
      const reg = await registration()
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        const endpoint = sub.endpoint
        await sub.unsubscribe()
        await fetch('/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint }),
        })
      }
      setStatus('Disabled on this device.')
    } catch (error) {
      setStatus(`Could not disable notifications: ${error.message || error}`)
    } finally {
      disableButton.disabled = false
    }
  })

  refresh()
})()
