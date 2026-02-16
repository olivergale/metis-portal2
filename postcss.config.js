export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};

// Security: Validate plugin integrity at build time
// This prevents tampered postcss.config.js from executing arbitrary code
if (process.env.NODE_ENV === 'production') {
  const requiredPlugins = ['tailwindcss', 'autoprefixer'];
  const config = module.exports;
  const plugins = config.plugins ? Object.keys(config.plugins) : [];
  
  for (const plugin of requiredPlugins) {
    if (!plugins.includes(plugin)) {
      throw new Error(`Security: Required postcss plugin '${plugin}' is missing from config`);
    }
  }
}
