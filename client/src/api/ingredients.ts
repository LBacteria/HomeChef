import {
  ApiError,
  type ConsumeIngredientInput,
  type CreateIngredientInput,
  type Ingredient,
  type UpdateIngredientInput,
} from '../types/ingredient'

/**
 * 食材 API 客户端。
 *
 * 只用浏览器原生 fetch，不引入 axios 等依赖。
 * 这里**只负责发请求与解析响应**，不写业务逻辑
 * （业务规则由后端 Service 决定，前端不做权威判断）。
 *
 * 开发期通过 Vite proxy 把 /api 转发到后端（见 vite.config.ts），
 * 因此这里使用相对路径即可，无需关心后端端口。
 */

const BASE = '/api'

/**
 * 解析错误响应，抛出带 code 的 ApiError。
 *
 * 后端统一错误格式：{ "error": { "code": "...", "message": "..." } }
 * 尽量把后端提供的 message 原样透出，不要笼统显示 "Something went wrong"。
 */
async function toApiError(response: Response): Promise<ApiError> {
  let code = 'UNKNOWN_ERROR'
  let message = `请求失败（HTTP ${response.status}）`

  try {
    const body = await response.json()

    if (body && typeof body === 'object' && body.error && typeof body.error === 'object') {
      if (typeof body.error.code === 'string') {
        code = body.error.code
      }
      if (typeof body.error.message === 'string' && body.error.message.length > 0) {
        message = body.error.message
      }
    }
  } catch {
    // 响应不是 JSON（例如 500 的意外情况），保留默认信息
  }

  return new ApiError(code, message, response.status)
}

/** 统一的请求封装 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response

  try {
    response = await fetch(`${BASE}${path}`, {
      headers: init?.body !== undefined ? { 'content-type': 'application/json' } : {},
      ...init,
    })
  } catch {
    // 网络层失败（后端未启动、代理失败等）
    throw new ApiError('NETWORK_ERROR', '无法连接到服务器，请确认后端已启动。', 0)
  }

  if (!response.ok) {
    throw await toApiError(response)
  }

  // 204 无 body
  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}

/** 查看库存列表 */
export function getIngredients(): Promise<Ingredient[]> {
  return request<Ingredient[]>('/ingredients')
}

/** 查看单个食材 */
export function getIngredient(id: number): Promise<Ingredient> {
  return request<Ingredient>(`/ingredients/${id}`)
}

/** 添加食材 */
export function createIngredient(data: CreateIngredientInput): Promise<Ingredient> {
  return request<Ingredient>('/ingredients', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

/** 修改食材 */
export function updateIngredient(
  id: number,
  data: UpdateIngredientInput,
): Promise<Ingredient> {
  return request<Ingredient>(`/ingredients/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

/** 删除食材 */
export function deleteIngredient(id: number): Promise<void> {
  return request<void>(`/ingredients/${id}`, { method: 'DELETE' })
}

/** 消耗食材 */
export function consumeIngredient(
  id: number,
  data: ConsumeIngredientInput,
): Promise<Ingredient> {
  return request<Ingredient>(`/ingredients/${id}/consume`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}
