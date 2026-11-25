// 设置待完善项（器材编号未完成 / 数量未填写）：
// 侧栏、设置页各级入口与具体配置页共用同一份数据，保证每层提示一致。
import { useEffect, useState } from 'react'
import { api } from './api'
import type { Catalog, InventoryRow } from './types'

export interface NumberingIssue {
  specId: string
  specName: string
  /** 应有编号数量 */
  target: number
  /** 已编号数量 */
  numbered: number
}

export interface QuantityIssue {
  specId: string
  specName: string
}

/** 所有启用规格的编号进度（无论是否已要求编号），用于编辑规格时的即时提示 */
export interface NumberingStatus {
  specId: string
  target: number
  numbered: number
}

export interface SettingsIssues {
  numbering: NumberingIssue[]
  numberingStatus: NumberingStatus[]
  quantity: QuantityIssue[]
  hasIssues: boolean
}

interface NumberingOverview {
  rows: {
    spec_id: string
    spec_name: string
    is_active: boolean
    boat_numbering_required: boolean
    target_quantity: number
    numbered_quantity: number
    complete: boolean
  }[]
}

const EMPTY: SettingsIssues = {
  numbering: [],
  numberingStatus: [],
  quantity: [],
  hasIssues: false,
}

let cache: SettingsIssues = EMPTY
let loaded = false
let inflight: Promise<SettingsIssues> | null = null
const listeners = new Set<(issues: SettingsIssues) => void>()

async function fetchIssues(): Promise<SettingsIssues> {
  const [numbering, inventory, catalog] = await Promise.all([
    api.get<NumberingOverview>('/api/boats/numbering'),
    api.get<InventoryRow[]>('/api/inventory'),
    api.get<Catalog>('/api/catalog'),
  ])
  const totalBySpec = new Map(
    inventory.map((r) => [r.equipment_spec_id, r.total_quantity ?? 0]),
  )
  const activeSpecs = catalog.equipment.filter((spec) => spec.is_active)
  const numberingIssues = numbering.rows
    .filter((r) => r.is_active && r.boat_numbering_required && !r.complete)
    .map((r) => ({
      specId: r.spec_id,
      specName: r.spec_name,
      target: r.target_quantity,
      numbered: r.numbered_quantity,
    }))
  const quantityIssues = activeSpecs
    .filter((spec) => (totalBySpec.get(spec.id) ?? 0) <= 0)
    .map((spec) => ({ specId: spec.id, specName: spec.name }))
  return {
    numbering: numberingIssues,
    numberingStatus: numbering.rows
      .filter((r) => r.is_active)
      .map((r) => ({
        specId: r.spec_id,
        target: r.target_quantity,
        numbered: r.numbered_quantity,
      })),
    quantity: quantityIssues,
    hasIssues: numberingIssues.length > 0 || quantityIssues.length > 0,
  }
}

// 重新拉取待完善项；并发调用共享同一次请求
export function refreshSettingsIssues(): Promise<SettingsIssues> {
  if (inflight) return inflight
  inflight = fetchIssues()
    .then((next) => {
      cache = next
      loaded = true
      listeners.forEach((listener) => listener(next))
      return next
    })
    .catch(() => cache)
    .finally(() => {
      inflight = null
    })
  return inflight
}

// 订阅待完善项：enabled=false 时不发起请求（无权限查看配置的用户）
export function useSettingsIssues(enabled = true): SettingsIssues {
  const [issues, setIssues] = useState(cache)
  useEffect(() => {
    if (!enabled) return
    listeners.add(setIssues)
    if (loaded) setIssues(cache)
    else refreshSettingsIssues()
    return () => {
      listeners.delete(setIssues)
    }
  }, [enabled])
  return issues
}
