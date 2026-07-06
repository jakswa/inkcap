export function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

export function readString(form: FormData, name: string) {
  return String(form.get(name) ?? '')
}
