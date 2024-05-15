import applyMixin from './mixin'
import devtoolPlugin from './plugins/devtool'
import ModuleCollection from './module/module-collection'
import { forEachValue, isObject, isPromise, assert, partial } from './util'

let Vue // bind on install

/************* class Store START **********************/
export class Store {
  constructor (options = {}) {
    // Auto install if it is not done yet and `window` has `Vue`.
    // To allow users to avoid auto-installation in some cases,
    // this code should be placed here. See #731
     // 如果是浏览器环境上通过 CDN 方式加载 Vue，则自动执行 install 方法
    if (!Vue && typeof window !== 'undefined' && window.Vue) {
      install(window.Vue)
    }

    // 判断是否满足必要条件
    if (__DEV__) {
      // 检测是否存在Vue了
      assert(Vue, `must call Vue.use(Vuex) before creating a store instance.`)
      // 检测是否存在 Promise
      assert(typeof Promise !== 'undefined', `vuex requires a Promise polyfill in this browser.`)
      // 检测是否是 Vuex 的实例
      assert(this instanceof Store, `store must be called with the new operator.`)
    }

    const {
      plugins = [], // 插件
      strict = false  // 严格模式
    } = options

    // store internal state
    // 初始化数据
    // 表示 commit 状态，用于判断是否是通过 commit 修改 state 属性
    this._committing = false 
    this._actions = Object.create(null)  // 存储封装后的 actions 集合
    this._actionSubscribers = []
    /**
     * {
     *   mutationKey1: [fn, fn],
     * }
     */
    this._mutations = Object.create(null)
    this._wrappedGetters = Object.create(null)
    this._modules = new ModuleCollection(options)// 构建 module 对象树
    // 收集模块命名空间 用以完成 根据模块区分 state mutation 等功能的 { moduleName : Module }
    this._modulesNamespaceMap = Object.create(null) //模块命名空间映射
    this._subscribers = []
    // 是一个 Vue 对象的实例，主要是利用 Vue 实例方法 $watch 来观测变化的
    this._watcherVM = new Vue()
    // getter 缓存
    this._makeLocalGettersCache = Object.create(null)

    // bind commit and dispatch to self
    // 将 commit 和 dispatch 绑定到 store实例上
    const store = this
    const { dispatch, commit } = this
    this.dispatch = function boundDispatch (type, payload) {
      return dispatch.call(store, type, payload)
    }
    this.commit = function boundCommit (type, payload, options) {
      return commit.call(store, type, payload, options)
    }

    // strict mode
    this.strict = strict

    const state = this._modules.root.state // 初始化根模块state

    // init root module.
    // this also recursively registers all sub-modules
    // and collects all module getters inside this._wrappedGetters
    // 初始化根模块， 同时递归注册所有子模块，同时收集所有模块的 getters
    installModule(this, state, [], this._modules.root)

    // initialize the store vm, which is responsible for the reactivity
    // (also registers _wrappedGetters as computed properties)
    // 初始化 store vm，它负责响应式（同时注册 _wrappedGetters 作为计算属性）
    resetStoreVM(this, state)

    // apply plugins
    // 初始化插件
    plugins.forEach(plugin => plugin(this))

    //初始化devTools
    const useDevtools = options.devtools !== undefined ? options.devtools : Vue.config.devtools
    if (useDevtools) {
      devtoolPlugin(this)
    }
  }

  // state 的getter
  // 代理 state 访问 返回 Vue 挂载的 $$state
  get state () {
    return this._vm._data.$$state
  }

  // state 的setter
  set state (v) {
    if (__DEV__) {
      assert(false, `use store.replaceState() to explicit replace store state.`)
    }
  }

  /**
   * 执行 mutation 方法
   * @param {*} _type 
   * @param {*} _payload 
   * @param {*} _options 
   * @returns 
   */
  commit (_type, _payload, _options) {
    // check object-style commit
    // 配置参数校验和处理
    const {
      type,
      payload,
      options
    } = unifyObjectStyle(_type, _payload, _options)

    const mutation = { type, payload }
    const entry = this._mutations[type]
    if (!entry) {
      if (__DEV__) {
        console.error(`[vuex] unknown mutation type: ${type}`)
      }
      return
    }
    // 用于判断是否是通过 commit 修改 state 属性
    this._withCommit(() => {
      entry.forEach(function commitIterator (handler) {
        handler(payload)
      })
    })

    // 如果有订阅函数存在，则逐个执行
    // 执行收集的 subscribe 的所有方法
    this._subscribers
      .slice() // shallow copy to prevent iterator invalidation if subscriber synchronously calls unsubscribe
      .forEach(sub => sub(mutation, this.state))

    if (
      __DEV__ &&
      options && options.silent
    ) {
      console.warn(
        `[vuex] mutation type: ${type}. Silent option has been removed. ` +
        'Use the filter functionality in the vue-devtools'
      )
    }
  }

  /**
   * 执行action 方法
   * @param {*} _type 
   * @param {*} _payload 
   * @returns 
   */
  dispatch (_type, _payload) {
    // check object-style dispatch
    const {
      type,
      payload
    } = unifyObjectStyle(_type, _payload)

    const action = { type, payload }
    const entry = this._actions[type]
    if (!entry) {
      if (__DEV__) {
        console.error(`[vuex] unknown action type: ${type}`)
      }
      return
    }

    try {
       // 执行收集的所有 subscribeAction.before action 触发前执行
      this._actionSubscribers
        .slice() // shallow copy to prevent iterator invalidation if subscriber synchronously calls unsubscribe
        .filter(sub => sub.before)
        .forEach(sub => sub.before(action, this.state))
    } catch (e) {
      if (__DEV__) {
        console.warn(`[vuex] error in before action subscribers: `)
        console.error(e)
      }
    }

    // 通过异步 Promise 向 actionSubscribers 传递 action 执行结果并执行
    // 若对应的 action 大于 1 用 Promise.all 创建一个 promise 迭代器 否则直接执行
    const result = entry.length > 1
      ? Promise.all(entry.map(handler => handler(payload)))
      : entry[0](payload)

    // 返回一个 Promise 里面执行 promise 迭代器
    return new Promise((resolve, reject) => {
      result.then(res => {
        try {
          // subscribeAction.after action 触发后执行
          this._actionSubscribers
            .filter(sub => sub.after)
            .forEach(sub => sub.after(action, this.state))
        } catch (e) {
          if (__DEV__) {
            console.warn(`[vuex] error in after action subscribers: `)
            console.error(e)
          }
        }
        resolve(res)
      }, error => {
        try {
          // subscribeAction.error action 触发后执行
          this._actionSubscribers
            .filter(sub => sub.error)
            .forEach(sub => sub.error(action, this.state, error))
        } catch (e) {
          if (__DEV__) {
            console.warn(`[vuex] error in error action subscribers: `)
            console.error(e)
          }
        }
        reject(error)
      })
    })
  }

  /**
   * 订阅
   * @param {*} fn 
   * @param {*} options 
   * @returns 
   */
  subscribe (fn, options) {
    return genericSubscribe(fn, this._subscribers, options)
  }

  subscribeAction (fn, options) {
    const subs = typeof fn === 'function' ? { before: fn } : fn
    return genericSubscribe(subs, this._actionSubscribers, options)
  }

  //通过vue的响应式系统，实现对state， getter的监听
  watch (getter, cb, options) {
    if (__DEV__) {
      assert(typeof getter === 'function', `store.watch only accepts a function.`)
    }
    return this._watcherVM.$watch(() => getter(this.state, this.getters), cb, options)
  }

  /**
   * 更新state
   * @param {*} state 
   */
  replaceState (state) {
    this._withCommit(() => {
      this._vm._data.$$state = state
    })
  }

  registerModule (path, rawModule, options = {}) {
    // 判断 path 是不是字符串 如果是就将其变为数组
    if (typeof path === 'string') path = [path]

    if (__DEV__) {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
      assert(path.length > 0, 'cannot register the root module by using registerModule.')
    }

    this._modules.register(path, rawModule)
    installModule(this, this.state, path, this._modules.get(path), options.preserveState)
    // reset store to update getters...
    resetStoreVM(this, this.state)
  }

  /**
   * 卸载 module
   * @param {*} path 
   */
  unregisterModule (path) {
    if (typeof path === 'string') path = [path]

    if (__DEV__) {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
    }

    this._modules.unregister(path)
    this._withCommit(() => {
      const parentState = getNestedState(this.state, path.slice(0, -1))
      Vue.delete(parentState, path[path.length - 1])
    })
    resetStore(this)
  }

  hasModule (path) {
    if (typeof path === 'string') path = [path]

    if (__DEV__) {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
    }

    return this._modules.isRegistered(path)
  }

  hotUpdate (newOptions) {
    this._modules.update(newOptions)
    resetStore(this, true)
  }

  /**
   * 保证修改是符合规则的
   *  // 在修改 state 期间，将内部属性 _committing 设置为 true
      // 通过 watch stateChange 查看 _committing 是否为 true 即可判断修改的合法性
   * @param {*} fn 
   */
  _withCommit (fn) {
    const committing = this._committing
    this._committing = true
    fn()
    this._committing = committing
  }
}


/************* class Store END **********************/

function genericSubscribe (fn, subs, options) {
  if (subs.indexOf(fn) < 0) {
    options && options.prepend
      ? subs.unshift(fn)
      : subs.push(fn)
  }
  return () => {
    const i = subs.indexOf(fn)
    if (i > -1) {
      subs.splice(i, 1)
    }
  }
}

/**
 * 重置状态
 * @param {*} store 
 * @param {*} hot 
 */
function resetStore (store, hot) {
  store._actions = Object.create(null)
  store._mutations = Object.create(null)
  store._wrappedGetters = Object.create(null)
  store._modulesNamespaceMap = Object.create(null)
  const state = store.state
  // init all modules
  installModule(store, state, [], store._modules.root, true)
  // reset vm
  resetStoreVM(store, state, hot)
}

/**
 * 遍历 _wrappedGetters 的属性，代理对 store.getters 的访问
 * 将 state 放到 Vue 实例的 $$state 上【 $ 开头的属性无法被Vue劫持】
 * 将 getters 的懒执行 也是依赖 computed
 * 判读是不是严格模式，若是则只能在 mutation 方法更改 state
 * 判断 是否存在 vue 实例如果有在 nextTicker 中销毁旧实例 
 * @param {*} store 
 * @param {*} state 
 * @param {*} hot 
 */
function resetStoreVM (store, state, hot) {
  const oldVm = store._vm

  // bind store public getters
  store.getters = {}
  // reset local getters cache
  store._makeLocalGettersCache = Object.create(null)
  const wrappedGetters = store._wrappedGetters
  const computed = {}
   // 遍历 wrappedGetters 给每个属性做代理
  forEachValue(wrappedGetters, (fn, key) => {
    // use computed to leverage its lazy-caching mechanism
    // direct inline function use will lead to closure preserving oldVm.
    // using partial to return function with only arguments preserved in closure environment.
    computed[key] = partial(fn, store)
    Object.defineProperty(store.getters, key, {
      get: () => store._vm[key],
      enumerable: true // for local getters
    })
  })

  // use a Vue instance to store the state tree
  // suppress warnings just in case the user has added
  // some funky global mixins
  const silent = Vue.config.silent
  Vue.config.silent = true
  store._vm = new Vue({
    data: {
      $$state: state
    },
    computed
  })
  Vue.config.silent = silent

  // enable strict mode for new vm
  if (store.strict) {
    //开启严格模式的数据流向监听
    enableStrictMode(store)
  }

  // 老 vue 实例是否存在
  if (oldVm) {
    //热更新模式下，将旧实例的 state 设置为 null
    if (hot) {
      // dispatch changes in all subscribed watchers
      // to force getter re-evaluation for hot reloading.
      store._withCommit(() => {
        oldVm._data.$$state = null
      })
    }
    Vue.nextTick(() => oldVm.$destroy())
  }
}

 /**
  * * 安装模块
  * 根据路径长度判断是否为根模块，获取命名空间，判断当前模块是否有命名空间，如果有则将其加入 _modulesNamespaceMap 中
  * 判断是否为根模块，如果不是则先获取父模块再获取子模块，用 Vue.set 将模块添加到父模块中，使其为响应式的数据
  * 获取上下文环境信息
  * 依次遍历 getters 、 mutation 、 action 将其分别加入对应的收集队列数组中
  * 判断是是否还有 modules 如果则遍历执行 installModule 完成深度遍历 module 
  * @param {*} store 当前实例
  * @param {*} rootState 根 state
  * @param {*} path 当前嵌套模块的路径数组
  * @param {*} module 当前安装的模块
  * @param {*} hot 当动态改变 modules 或者热更新的时候为 true
  */
function installModule (store, rootState, path, module, hot) {
  // 通过 path 数组的长度判断是否为根模块
  const isRoot = !path.length
  const namespace = store._modules.getNamespace(path)

  // register in namespace map
  // 注册进模块 namespace map，防止命名冲突
  // 就是通过 path 字段，利用 reduce 递归拼接 module 名称
  if (module.namespaced) {
    if (store._modulesNamespaceMap[namespace] && __DEV__) {
      console.error(`[vuex] duplicate namespace ${namespace} for the namespaced module ${path.join('/')}`)
    }
    store._modulesNamespaceMap[namespace] = module
  }

  // set state
  // 当不为根且非热更新的情况，然后设置级联状态
  // 把模块的 state 设置到 state._vm.$data 的 $$state 属性中，其中 state._vm 定义在 resetStoreVM 中
  if (!isRoot && !hot) {
    // 获取父模块 state
    const parentState = getNestedState(rootState, path.slice(0, -1))
    // 获取模块名称 path = ['a','c'] 这里就是 c ， c 是子模块名 a 是他的父模块
    const moduleName = path[path.length - 1]
    store._withCommit(() => {
      if (__DEV__) {
        if (moduleName in parentState) {
          console.warn(
            `[vuex] state field "${moduleName}" was overridden by a module with the same name at "${path.join('.')}"`
          )
        }
      }
      // 实现模块的响应式 state 注册
      // 将对应的 module 变为响应式的
      Vue.set(parentState, moduleName, module.state)
    })
  }

  // module上下文环境生成
  const local = module.context = makeLocalContext(store, namespace, path)

  // 注册一系列 mutations 、actions 以及 getters，并将其 this 绑定到当前 store 对象
  module.forEachMutation((mutation, key) => {
    const namespacedType = namespace + key
    registerMutation(store, namespacedType, mutation, local)
  })

  module.forEachAction((action, key) => {
    const type = action.root ? key : namespace + key
    const handler = action.handler || action
    registerAction(store, type, handler, local)
  })

  module.forEachGetter((getter, key) => {
    const namespacedType = namespace + key
    registerGetter(store, namespacedType, getter, local)
  })

  // 递归安装子 module
  module.forEachChild((child, key) => {
    installModule(store, rootState, path.concat(key), child, hot)
  })
}

/**
 * make localized dispatch, commit, getters and state
 * if there is no namespace, just use root ones
 * 可以发现makeLocalContext函数重新封装了 mutations、actions、getters、state 属性
 * module 访问的这些对象属性实际上访问执行的就是设置的上下文环境属性，用于兼容 namespace 的存在。
 */
function makeLocalContext (store, namespace, path) {
  const noNamespace = namespace === ''

  const local = {
    dispatch: noNamespace ? store.dispatch : (_type, _payload, _options) => {
      const args = unifyObjectStyle(_type, _payload, _options)
      const { payload, options } = args
      let { type } = args
      // 给 type 添加前置模块命名
      if (!options || !options.root) {
        type = namespace + type
        if (__DEV__ && !store._actions[type]) {
          console.error(`[vuex] unknown local action type: ${args.type}, global type: ${type}`)
          return
        }
      }

      return store.dispatch(type, payload)
    },

    commit: noNamespace ? store.commit : (_type, _payload, _options) => {
      const args = unifyObjectStyle(_type, _payload, _options)
      const { payload, options } = args
      let { type } = args

      if (!options || !options.root) {
        type = namespace + type
        if (__DEV__ && !store._mutations[type]) {
          console.error(`[vuex] unknown local mutation type: ${args.type}, global type: ${type}`)
          return
        }
      }

      store.commit(type, payload, options)
    }
  }

  // getters and state object must be gotten lazily
  // because they will be changed by vm update
  Object.defineProperties(local, {
    getters: {
      get: noNamespace
        ? () => store.getters
        : () => makeLocalGetters(store, namespace)
    },
    state: {
      get: () => getNestedState(store.state, path)
    }
  })

  return local
}

function makeLocalGetters (store, namespace) {
  if (!store._makeLocalGettersCache[namespace]) {
    const gettersProxy = {}
    const splitPos = namespace.length
    Object.keys(store.getters).forEach(type => {
      // skip if the target getter is not match this namespace
      if (type.slice(0, splitPos) !== namespace) return

      // extract local getter type
      const localType = type.slice(splitPos)

      // Add a port to the getters proxy.
      // Define as getter property because
      // we do not want to evaluate the getters in this time.
      Object.defineProperty(gettersProxy, localType, {
        get: () => store.getters[type],
        enumerable: true
      })
    })
    store._makeLocalGettersCache[namespace] = gettersProxy
  }

  return store._makeLocalGettersCache[namespace]
}

/**
 * 
 * @param {*} store 实例
 * @param {*} type mutation 的 key
 * @param {*} handler 为 mutation 执行的回调函数
 * @param {*} local 
 * 生成一个mutation数组，数组中的每一个元素都是一个回调函数，该回调函数执行时，会调用 mutation 的回调函数
 */
function registerMutation (store, type, handler, local) {
  const entry = store._mutations[type] || (store._mutations[type] = [])
  entry.push(function wrappedMutationHandler (payload) {
    handler.call(store, local.state, payload)
  })
}

function registerAction (store, type, handler, local) {
  const entry = store._actions[type] || (store._actions[type] = [])
  entry.push(function wrappedActionHandler (payload) {
    let res = handler.call(store, {
      dispatch: local.dispatch,
      commit: local.commit,
      getters: local.getters,
      state: local.state,
      rootGetters: store.getters,
      rootState: store.state
    }, payload)
    if (!isPromise(res)) {
      res = Promise.resolve(res)
    }
    if (store._devtoolHook) {
      return res.catch(err => {
        store._devtoolHook.emit('vuex:error', err)
        throw err
      })
    } else {
      return res
    }
  })
}

function registerGetter (store, type, rawGetter, local) {
  if (store._wrappedGetters[type]) {
    if (__DEV__) {
      console.error(`[vuex] duplicate getter key: ${type}`)
    }
    return
  }
  store._wrappedGetters[type] = function wrappedGetter (store) {
    return rawGetter(
      local.state, // local state
      local.getters, // local getters
      store.state, // root state
      store.getters // root getters
    )
  }
}

/**
 * 严格模式下 数据流向检测
 * @param {*} store 
 */
function enableStrictMode (store) {
  store._vm.$watch(function () { return this._data.$$state }, () => {
    if (__DEV__) {
      assert(store._committing, `do not mutate vuex store state outside mutation handlers.`)
    }
  }, { deep: true, sync: true })
}

function getNestedState (state, path) {
  return path.reduce((state, key) => state[key], state)
}

function unifyObjectStyle (type, payload, options) {
  if (isObject(type) && type.type) {
    options = payload
    payload = type
    type = type.type
  }

  if (__DEV__) {
    assert(typeof type === 'string', `expects string as the type, but found ${typeof type}.`)
  }

  return { type, payload, options }
}

/**
 * 插件注册方法
 * @param {*} _Vue 
 * @returns 
 */
export function install (_Vue) {
  // 防止 Vuex 重复装载
  if (Vue && _Vue === Vue) {
    if (__DEV__) {
      console.error(
        '[vuex] already installed. Vue.use(Vuex) should be called only once.'
      )
    }
    return
  }
  Vue = _Vue
  applyMixin(Vue)
}
