/* web/src/index.css */

@import url("https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap");
@import "tailwindcss";

@theme {
  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
}

@layer base {
  * {
    border-color: #e5e7eb;
  }

  html {
    font-family: "Inter", ui-sans-serif, system-ui, sans-serif;
  }

  body {
    margin: 0;
    background-color: #f9fafb;
    color: #111827;
    font-family: "Inter", ui-sans-serif, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  ::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }

  ::-webkit-scrollbar-track {
    background: transparent;
  }

  ::-webkit-scrollbar-thumb {
    background-color: #d1d5db;
    border-radius: 9999px;
  }

  ::-webkit-scrollbar-thumb:hover {
    background-color: #9ca3af;
  }
}

@utility scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

@utility scrollbar-hide::-webkit-scrollbar {
  display: none;
}