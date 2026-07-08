import { describe, expect, test } from 'bun:test'

const { toRenderable } = await import('../src/utils/message-view')

describe('message view model', () => {
  test('turns submit_artifact tool results into nearby artifact links', () => {
    const rendered = toRenderable({
      role: 'tool',
      status: 'complete',
      content:
        'Artifact saved: Daily Briefing\nOpen it at /artifacts/018fd7b4-0000-7000-8000-000000000000',
    })

    expect(rendered.artifactLinks).toEqual([
      {
        id: '018fd7b4-0000-7000-8000-000000000000',
        title: 'Daily Briefing',
        href: '/artifacts/018fd7b4-0000-7000-8000-000000000000',
        downloadHref: '/artifacts/018fd7b4-0000-7000-8000-000000000000/download',
      },
    ])
  })
})
