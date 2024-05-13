export default function (Vue) {
  // 检Vue测版本号
  const version = Number(Vue.version.split('.')[0])

  //Vue2.x版本 通过mixin 使用 hook 方式进行 store 对象注入
  if (version >= 2) {
    Vue.mixin({ beforeCreate: vuexInit })
  } else {
    // override init and inject vuex init procedure
    // for 1.x backwards compatibility.
    // Vue1.x版本 通过重写_init方法
    const _init = Vue.prototype._init
    Vue.prototype._init = function (options = {}) {
      options.init = options.init
        ? [vuexInit].concat(options.init)
        : vuexInit
      _init.call(this, options)
    }
  }

  /**
   * Vuex init hook, injected into each instances init hooks list.
   * 初始化钩子，注入到每个实例的初始化钩子列表中
   */

  /**
   * 给Vue的实例对象注入$store属性
   */
  function vuexInit () {
    const options = this.$options
    // store injection
    if (options.store) {
      // 将 store 对象注入到根组件的 $store 属性上
      this.$store = typeof options.store === 'function'
        ? options.store()
        : options.store
    } else if (options.parent && options.parent.$store) {
      // 将子组件的 $store 属性指向父组件的 $store 属性上
      this.$store = options.parent.$store
    }
  }
}
