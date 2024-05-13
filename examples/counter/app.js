import Vue from 'vue'
import Counter from './Counter.vue'
import store from './store' 
let a = new Vue({
  el: '#app',
  store,
  myApp:{'version':'1.0.0', 'desc':'自定义外置插件'},
  render: h => h(Counter)
})

console.log(a)
