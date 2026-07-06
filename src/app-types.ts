export type CurrentUser = {
  id: string
  name: string
  email: string
  created_at: Date
} | null

export type Renderer = (
  template: string,
  data?: Record<string, unknown>,
) => Promise<Response>

declare module 'hono' {
  interface ContextVariableMap {
    render: Renderer
    user: CurrentUser
  }
}
