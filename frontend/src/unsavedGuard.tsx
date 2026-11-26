// 设置页未保存修改提醒：保存并继续 / 不保存 / 取消
import { useEffect } from 'react'
import { Button, Modal, Space } from 'antd'

export interface UnsavedGuard {
  /** 当前是否有未保存的改动 */
  isDirty: () => boolean
  /** 有改动时询问是否保存；返回 true 表示可以离开 */
  confirmLeave: () => Promise<boolean>
}

/**
 * 弹出「是否保存」提示框。
 * 返回值：true 表示可以继续离开（已保存或选择不保存），false 表示留在当前页。
 */
export function confirmUnsavedChanges(
  save: () => Promise<boolean> | boolean,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false
    let inst: ReturnType<typeof Modal.confirm> | null = null
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      inst?.destroy()
      resolve(ok)
    }
    inst = Modal.confirm({
      title: '有未保存的设置',
      content: '当前修改尚未保存，是否保存后继续？',
      footer: (
        <Space style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <Button onClick={() => finish(false)}>取消</Button>
          <Button danger onClick={() => finish(true)}>
            不保存
          </Button>
          <Button
            type="primary"
            onClick={async () => {
              const ok = await save()
              if (ok) finish(true)
            }}
          >
            保存并继续
          </Button>
        </Space>
      ),
    })
  })
}

/** 刷新/关闭页面前提示未保存（浏览器原生提示） */
export function useBeforeUnloadWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])
}
