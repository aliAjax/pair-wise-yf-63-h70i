export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  modules: ['@pinia/nuxt', '@element-plus/nuxt', '@vueuse/nuxt', '@nuxtjs/i18n'],
  css: ['~/assets/main.css'],
  devServer: { host: '0.0.0.0', port: 62028 },
  i18n: {
    defaultLocale: 'zh',
    strategy: 'no_prefix',
    locales: [
      { code: 'zh', name: '中文', file: 'zh.json' },
      { code: 'en', name: 'English', file: 'en.json' }
    ],
    detectBrowserLanguage: false
  },
  typescript: { strict: true, typeCheck: false }
});
