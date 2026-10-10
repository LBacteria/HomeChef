import {
  ApiError,
  type Alias,
  type CreateDefinitionInput,
  type DefinitionSortOrder,
  type IngredientDefinition,
  type IngredientDefinitionDetail,
  type UpdateDefinitionInput,
} from '../types/api'

/**
 * 公共请求封装。
 *
 * 只用浏览器原生 fetch。
 * 只负责发请求与解析响应，**不含任何业务规则**。
 *
 * 开发期通过 Vite proxy 把 /api 转发到后端（见 vite.config.ts）。
 */

const BASE = '/api'

/** 解析后端统一错误格式 { error: { code, message } } */
async function toApiError(response: Response): Promise<ApiError> {
  let code = 'UNKNOWN_ERROR'
  let message = `请求失败（HTTP ${response.status}）`

  try {
    const body = await response.json()
    if (body && typeof body === 'object' && body.error && typeof body.error === 'object') {
      if (typeof body.error.code === 'string') code = body.error.code
      if (typeof body.error.message === 'string' && body.error.message.length > 0) {
        message = body.error.message
      }
    }
  } catch {
    // 响应不是 JSON，保留默认信息
  }

  return new ApiError(code, message, response.status)
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response

  try {
    response = await fetch(`${BASE}${path}`, {
      headers: init?.body !== undefined ? { 'content-type': 'application/json' } : {},
      ...init,
    })
  } catch {
    throw new ApiError('NETWORK_ERROR', '无法连接到服务器，请确认后端已启动。', 0)
  }

  if (!response.ok) {
    throw await toApiError(response)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}

/* ============================================================
 * 食材定义 API
 * ============================================================ */

/**
 * 列出 / 搜索食材定义。
 *
 * ⚠️ search 是**后端 substring 包含匹配**（名称 + 别名），
 *    前端不做任何过滤或匹配逻辑。
 *
 * ⚠️ 排序同样由**后端**执行（v0.1.2 Batch 3）：
 *    前端只传参，不复制排序规则。
 *
 * @param search 搜索词（为空则列出全部）
 * @param order  名称排序方向，默认 asc（A → Z）
 */
export function listDefinitions(
  search?: string,
  order: DefinitionSortOrder = 'asc',
  categoryId?: number | null,
): Promise<IngredientDefinitionDetail[]> {
  const params = new URLSearchParams()
  if (search !== undefined && search.trim().length > 0) {
    params.set('search', search.trim())
  }
  params.set('sort', 'name')
  params.set('order', order)
  // v0.1.3：分类筛选（null / undefined = 全部）
  if (categoryId !== null && categoryId !== undefined) {
    params.set('category_id', String(categoryId))
  }

  return request<IngredientDefinitionDetail[]>(`/definitions?${params.toString()}`)
}

/** 获取单个定义（含 aliases 与 allowed_units） */
export function getDefinition(id: number): Promise<IngredientDefinitionDetail> {
  return request<IngredientDefinitionDetail>(`/definitions/${id}`)
}

/** 创建定义 */
export function createDefinition(
  data: CreateDefinitionInput,
): Promise<IngredientDefinition> {
  return request<IngredientDefinition>('/definitions', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

/** 更新定义（默认名称 / 预计保质期） */
export function updateDefinition(
  id: number,
  data: UpdateDefinitionInput,
): Promise<IngredientDefinition> {
  return request<IngredientDefinition>(`/definitions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

/**
 * 删除定义。
 *
 * ⚠️ 有库存记录时后端返回 409 HAS_STOCK，前端只显示错误。
 */
export function deleteDefinition(id: number): Promise<void> {
  return request<void>(`/definitions/${id}`, { method: 'DELETE' })
}

/* ============================================================
 * 统一保存（v0.1.4 第二批）
 * ============================================================ */

/** 别名草稿：id 为 null 表示新增 */
export interface AliasDraftPayload {
  id: number | null
  alias: string
}

/**
 * 统一保存食材定义（**单个请求**）。
 *
 * ⚠️ 后端在**同一个事务**内完成全部改动：
 *    基础字段 + 别名 + 单位 + 设为默认。
 *    任一步失败整体回滚，**不存在部分保存**，因此重试永远安全。
 */
export interface SaveDefinitionFullPayload {
  name?: string
  category_id?: number | null
  estimated_shelf_life_days?: number | null
  /** 别名最终状态（全量草稿） */
  aliases?: AliasDraftPayload[]
  /** 允许单位最终状态（全量草稿） */
  units?: string[]
  /** 要提升为默认名称的别名 id */
  set_default_alias_id?: number
}

export function saveDefinitionFull(
  id: number,
  payload: SaveDefinitionFullPayload,
): Promise<IngredientDefinition> {
  return request<IngredientDefinition>(`/definitions/${id}/full`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

/* ============================================================
 * 别名 API
 * ============================================================ */

export function listAliases(definitionId: number): Promise<Alias[]> {
  return request<Alias[]>(`/definitions/${definitionId}/aliases`)
}

export function addAlias(definitionId: number, alias: string): Promise<Alias> {
  return request<Alias>(`/definitions/${definitionId}/aliases`, {
    method: 'POST',
    body: JSON.stringify({ alias }),
  })
}

export function updateAlias(
  definitionId: number,
  aliasId: number,
  alias: string,
): Promise<Alias> {
  return request<Alias>(`/definitions/${definitionId}/aliases/${aliasId}`, {
    method: 'PATCH',
    body: JSON.stringify({ alias }),
  })
}

export function deleteAlias(definitionId: number, aliasId: number): Promise<void> {
  return request<void>(`/definitions/${definitionId}/aliases/${aliasId}`, {
    method: 'DELETE',
  })
}

/**
 * 把某个别名设为默认名称。
 *
 * 后端在事务内完成：原默认名称降级为别名、新默认名称从别名移除。
 * definition ID 不变。
 */
export function setDefaultName(
  definitionId: number,
  aliasId: number,
): Promise<IngredientDefinition> {
  return request<IngredientDefinition>(`/definitions/${definitionId}/default-name`, {
    method: 'POST',
    body: JSON.stringify({ alias_id: aliasId }),
  })
}

/* ============================================================
 * 允许单位 API
 * ============================================================ */

export function listAllowedUnits(definitionId: number): Promise<string[]> {
  return request<string[]>(`/definitions/${definitionId}/units`)
}

export function addAllowedUnit(definitionId: number, unit: string): Promise<unknown> {
  return request<unknown>(`/definitions/${definitionId}/units`, {
    method: 'POST',
    body: JSON.stringify({ unit }),
  })
}

/**
 * 移除允许单位。
 *
 * ⚠️ 后端在以下情况返回错误，前端只显示消息，不自行判断：
 *   - 409 UNIT_IN_USE：仍有库存使用该单位
 *   - 400：这是最后一个允许单位
 */
export function removeAllowedUnit(definitionId: number, unit: string): Promise<void> {
  return request<void>(`/definitions/${definitionId}/units/${encodeURIComponent(unit)}`, {
    method: 'DELETE',
  })
}
