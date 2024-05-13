/**
 * Get the first item that pass the test
 * by second argument function
 *
 * @param {Array} list
 * @param {Function} f
 * @return {*}  使用filter过滤数组的第一个元素
 */
export function find (list, f) {
  return list.filter(f)[0]
}

/**
 * Deep copy the given object considering circular structure.
 * This function caches all nested objects and its copies.
 * If it detects circular structure, use cached copy to avoid infinite loop.
 *
 * @param {*} obj
 * @param {Array<Object>} cache
 * @return {*} 递归拷贝
 */
export function deepCopy (obj, cache = []) {
  // just return if obj is immutable value
  if (obj === null || typeof obj !== 'object') {
    return obj
  }

  // if obj is hit, it is in circular structure
  const hit = find(cache, c => c.original === obj)
  if (hit) {
    return hit.copy
  }

  const copy = Array.isArray(obj) ? [] : {}
  // put the copy into cache at first
  // because we want to refer it in recursive deepCopy
  cache.push({
    original: obj,
    copy
  })

  Object.keys(obj).forEach(key => {
    copy[key] = deepCopy(obj[key], cache)
  })

  return copy
}

/**
 * forEach for object
 * 遍历对象
 */
export function forEachValue (obj, fn) {
  Object.keys(obj).forEach(key => fn(obj[key], key))
}

export function isObject (obj) {
  return obj !== null && typeof obj === 'object'
}

export function isPromise (val) {
  return val && typeof val.then === 'function'
}

/**
 * 抛出异常
 * @param {*} condition 
 * @param {*} msg 
 */
export function assert (condition, msg) {
  if (!condition) throw new Error(`[vuex] ${msg}`)
}

/**
 * 函数柯里化
 * @param {*} fn 
 * @param {*} arg 
 */
export function partial (fn, arg) {
  return function () {
    return fn(arg)
  }
}
