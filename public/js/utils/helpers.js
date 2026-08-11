// ═══════════════════════════════════════════════════════════════════
// HTML FORMAT ESCAPER
// ═══════════════════════════════════════════════════════════════════
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escId(s) {
  return String(s).replace(/[^A-Za-z0-9]/g, '_');
}

// ═══════════════════════════════════════════════════════════════════
// SETTINGS OPERATIONS
// ═══════════════════════════════════════════════════════════════════
const THEMES = {
  'dark-2026': {
    isLight: false,
    variables: {
      '--bg': '#000000',
      '--bg2': '#0d0d0d',
      '--bg3': '#151515',
      '--bg4': '#222222',
      '--bg5': '#2a2a2a',
      '--actbar': '#080808',
      '--border': '#222222',
      '--border2': '#333333',
      '--text': '#cccccc',
      '--text2': '#9d9d9d',
      '--text3': '#858585',
      '--hl': '#094771',
      '--hl2': '#2a2d2e',
      '--blue': '#007acc',
      '--blue2': '#4fc1ff',
      '--green': '#2a2a2a',
      '--green2': '#cccccc',
      '--green3': '#e0e0e0',
      '--mongo': '#1a1a1a',
      '--statusbar': '#000000'
    },
    editor: {
      bg: '#1e1e1e',
      text: '#d4d4d4',
      gutters: '#1e1e1e',
      gutterBorder: '#2d2d2d',
      linenumber: '#858585',
      activeLine: 'rgba(255, 255, 255, 0.03)',
      selected: '#264f78',
      cursor: '#c6c6c6',
      keyword: '#569cd6',
      string: '#ce9178',
      number: '#b5cea8',
      comment: '#6a9955',
      property: '#9cdcfe',
      variable: '#9cdcfe',
      def: '#dcdcaa',
      operator: '#d4d4d4',
      atom: '#569cd6',
      punctuation: '#d4d4d4'
    }
  },
  'abyss': {
    isLight: false,
    variables: {
      '--bg': '#000c18',
      '--bg2': '#001224',
      '--bg3': '#001a33',
      '--bg4': '#052242',
      '--bg5': '#083261',
      '--actbar': '#000810',
      '--border': '#082d54',
      '--border2': '#0c437a',
      '--text': '#bfe2ff',
      '--text2': '#80c4ff',
      '--text3': '#4d90e0',
      '--hl': '#04396c',
      '--hl2': '#002244',
      '--blue': '#66b2ff',
      '--blue2': '#99ccff',
      '--green': '#001a33',
      '--green2': '#80c4ff',
      '--green3': '#bfe2ff',
      '--mongo': '#001224',
      '--statusbar': '#000c18'
    },
    editor: {
      bg: '#000c18',
      text: '#66ccff',
      gutters: '#001224',
      gutterBorder: '#082d54',
      linenumber: '#003b73',
      activeLine: 'rgba(255,255,255,0.05)',
      selected: '#124373',
      cursor: '#ddbb00',
      keyword: '#ddbb00',
      string: '#22aa44',
      number: '#f28010',
      comment: '#385570',
      def: '#66ccff',
      variable: '#66ccff',
      property: '#99ccff',
      operator: '#bfe2ff',
      atom: '#ddbb00',
      punctuation: '#bfe2ff'
    }
  },
  'dark-vs': {
    isLight: false,
    variables: {
      '--bg': '#1e1e1e',
      '--bg2': '#252526',
      '--bg3': '#2d2d30',
      '--bg4': '#3e3e42',
      '--bg5': '#555555',
      '--actbar': '#2d2d30',
      '--border': '#3f3f46',
      '--border2': '#555555',
      '--text': '#d4d4d4',
      '--text2': '#9b9b9b',
      '--text3': '#6c6c6c',
      '--hl': '#264f78',
      '--hl2': '#094771',
      '--blue': '#007acc',
      '--blue2': '#4fc1ff',
      '--green': '#2d2d30',
      '--green2': '#4ec1ff',
      '--green3': '#9cdcfe',
      '--mongo': '#252526',
      '--statusbar': '#007acc'
    },
    editor: {
      bg: '#1e1e1e',
      text: '#d4d4d4',
      gutters: '#1e1e1e',
      gutterBorder: '#3f3f46',
      linenumber: '#858585',
      activeLine: '#282828',
      selected: '#264f78',
      cursor: '#c6c6c6',
      keyword: '#569cd6',
      string: '#ce9178',
      number: '#b5cea8',
      comment: '#6a9955',
      def: '#dcdcaa',
      variable: '#9cdcfe',
      property: '#9cdcfe',
      operator: '#d4d4d4',
      atom: '#569cd6',
      punctuation: '#d4d4d4'
    }
  },
  'dark-hc': {
    isLight: false,
    variables: {
      '--bg': '#000000',
      '--bg2': '#000000',
      '--bg3': '#000000',
      '--bg4': '#000000',
      '--bg5': '#222222',
      '--actbar': '#000000',
      '--border': '#6fc3df',
      '--border2': '#ffffff',
      '--text': '#ffffff',
      '--text2': '#ffffff',
      '--text3': '#ffffff',
      '--hl': '#007acc',
      '--hl2': '#222222',
      '--blue': '#6fc3df',
      '--blue2': '#6fc3df',
      '--green': '#000000',
      '--green2': '#ffffff',
      '--green3': '#ffffff',
      '--mongo': '#000000',
      '--statusbar': '#000000'
    },
    editor: {
      bg: '#000000',
      text: '#ffffff',
      gutters: '#000000',
      gutterBorder: '#6fc3df',
      linenumber: '#ffffff',
      activeLine: '#111111',
      selected: '#007acc',
      cursor: '#ffffff',
      keyword: '#569cd6',
      string: '#ce9178',
      number: '#b5cea8',
      comment: '#6a9955',
      def: '#dcdcaa',
      variable: '#9cdcfe',
      property: '#9cdcfe',
      operator: '#ffffff',
      atom: '#569cd6',
      punctuation: '#ffffff'
    }
  },
  'dark-modern': {
    isLight: false,
    variables: {
      '--bg': '#1f1f1f',
      '--bg2': '#181818',
      '--bg3': '#181818',
      '--bg4': '#2b2b2b',
      '--bg5': '#373737',
      '--actbar': '#181818',
      '--border': '#2b2b2b',
      '--border2': '#3c3c3c',
      '--text': '#cccccc',
      '--text2': '#9d9d9d',
      '--text3': '#858585',
      '--hl': '#04395e',
      '--hl2': '#2a2d2e',
      '--blue': '#007acc',
      '--blue2': '#4fc1ff',
      '--green': '#181818',
      '--green2': '#4fc1ff',
      '--green3': '#9cdcfe',
      '--mongo': '#1f1f1f',
      '--statusbar': '#181818'
    },
    editor: {
      bg: '#1f1f1f',
      text: '#cccccc',
      gutters: '#1f1f1f',
      gutterBorder: '#2b2b2b',
      linenumber: '#858585',
      activeLine: 'rgba(255,255,255,0.02)',
      selected: '#04395e',
      cursor: '#cccccc',
      keyword: '#4fc1ff',
      string: '#ce9178',
      number: '#b5cea8',
      comment: '#6a9955',
      def: '#dcdcaa',
      variable: '#9cdcfe',
      property: '#9cdcfe',
      operator: '#cccccc',
      atom: '#569cd6',
      punctuation: '#cccccc'
    }
  },
  'dark-plus': {
    isLight: false,
    variables: {
      '--bg': '#1e1e1e',
      '--bg2': '#252526',
      '--bg3': '#1e1e1e',
      '--bg4': '#3c3c3c',
      '--bg5': '#505050',
      '--actbar': '#333333',
      '--border': '#252526',
      '--border2': '#3c3c3c',
      '--text': '#cccccc',
      '--text2': '#9d9d9d',
      '--text3': '#808080',
      '--hl': '#264f78',
      '--hl2': '#3a3d41',
      '--blue': '#007acc',
      '--blue2': '#4fc1ff',
      '--green': '#252526',
      '--green2': '#4ec1ff',
      '--green3': '#9cdcfe',
      '--mongo': '#1e1e1e',
      '--statusbar': '#007acc'
    },
    editor: {
      bg: '#1e1e1e',
      text: '#d4d4d4',
      gutters: '#1e1e1e',
      gutterBorder: '#252526',
      linenumber: '#858585',
      activeLine: '#282828',
      selected: '#264f78',
      cursor: '#c6c6c6',
      keyword: '#569cd6',
      string: '#ce9178',
      number: '#b5cea8',
      comment: '#6a9955',
      def: '#dcdcaa',
      variable: '#9cdcfe',
      property: '#9cdcfe',
      operator: '#d4d4d4',
      atom: '#569cd6',
      punctuation: '#d4d4d4'
    }
  },
  'kimbie-dark': {
    isLight: false,
    variables: {
      '--bg': '#221a0f',
      '--bg2': '#2c2214',
      '--bg3': '#362b1a',
      '--bg4': '#4a3c25',
      '--bg5': '#5e4d2f',
      '--actbar': '#221a0f',
      '--border': '#443520',
      '--border2': '#5c472b',
      '--text': '#d3af86',
      '--text2': '#ba9872',
      '--text3': '#8a7051',
      '--hl': '#644a26',
      '--hl2': '#362b1a',
      '--blue': '#f79a32',
      '--blue2': '#8ab3b5',
      '--green': '#2c2214',
      '--green2': '#a57a4c',
      '--green3': '#dc7062',
      '--mongo': '#221a0f',
      '--statusbar': '#221a0f'
    },
    editor: {
      bg: '#221a0f',
      text: '#d3af86',
      gutters: '#221a0f',
      gutterBorder: '#443520',
      linenumber: '#8a7051',
      activeLine: 'rgba(255,255,255,0.02)',
      selected: '#644a26',
      cursor: '#d3af86',
      keyword: '#dc7062',
      string: '#8ab3b5',
      number: '#f79a32',
      comment: '#a57a4c',
      def: '#f79a32',
      variable: '#d3af86',
      property: '#d3af86',
      operator: '#98676A',
      atom: '#dc7062',
      punctuation: '#d3af86'
    }
  },
  'light-vs': {
    isLight: true,
    variables: {
      '--bg': '#ffffff',
      '--bg2': '#f3f3f3',
      '--bg3': '#eeeeee',
      '--bg4': '#e2e2e2',
      '--bg5': '#cfcfcf',
      '--actbar': '#2c2c2c',
      '--border': '#d4d4d4',
      '--border2': '#b8b8b8',
      '--text': '#000000',
      '--text2': '#333333',
      '--text3': '#6f6f6f',
      '--hl': '#add6ff',
      '--hl2': '#e4e6f1',
      '--blue': '#007acc',
      '--blue2': '#0000ff',
      '--green': '#f3f3f3',
      '--green2': '#008000',
      '--green3': '#a31515',
      '--mongo': '#ffffff',
      '--statusbar': '#007acc'
    },
    editor: {
      bg: '#ffffff',
      text: '#000000',
      gutters: '#ffffff',
      gutterBorder: '#d4d4d4',
      linenumber: '#2b91af',
      activeLine: '#f2f7ff',
      selected: '#add6ff',
      cursor: '#000000',
      keyword: '#0000ff',
      string: '#a31515',
      number: '#098658',
      comment: '#008000',
      def: '#795e26',
      variable: '#000000',
      property: '#000000',
      operator: '#000000',
      atom: '#0000ff',
      punctuation: '#000000'
    }
  },
  'light-2026': {
    isLight: true,
    variables: {
      '--bg': '#fafafa',
      '--bg2': '#f0f0f0',
      '--bg3': '#e6e6e6',
      '--bg4': '#d9d9d9',
      '--bg5': '#cccccc',
      '--actbar': '#e1e1e1',
      '--border': '#e0e0e0',
      '--border2': '#d0d0d0',
      '--text': '#333333',
      '--text2': '#555555',
      '--text3': '#777777',
      '--hl': '#e2eafc',
      '--hl2': '#ececec',
      '--blue': '#0053a6',
      '--blue2': '#098658',
      '--green': '#f0f0f0',
      '--green2': '#508050',
      '--green3': '#b03020',
      '--mongo': '#fafafa',
      '--statusbar': '#f3f3f3'
    },
    editor: {
      bg: '#fafafa',
      text: '#333333',
      gutters: '#fafafa',
      gutterBorder: '#e0e0e0',
      linenumber: '#777777',
      activeLine: '#f4f5f8',
      selected: '#e2eafc',
      cursor: '#333333',
      keyword: '#0053a6',
      string: '#b03020',
      number: '#098658',
      comment: '#508050',
      def: '#795e26',
      variable: '#333333',
      property: '#333333',
      operator: '#333333',
      atom: '#0053a6',
      punctuation: '#333333'
    }
  },
  'light-hc': {
    isLight: true,
    variables: {
      '--bg': '#ffffff',
      '--bg2': '#ffffff',
      '--bg3': '#ffffff',
      '--bg4': '#ffffff',
      '--bg5': '#dddddd',
      '--actbar': '#ffffff',
      '--border': '#000000',
      '--border2': '#000000',
      '--text': '#000000',
      '--text2': '#000000',
      '--text3': '#000000',
      '--hl': '#add6ff',
      '--hl2': '#eeeeee',
      '--blue': '#0000ff',
      '--blue2': '#0000ff',
      '--green': '#ffffff',
      '--green2': '#000000',
      '--green3': '#000000',
      '--mongo': '#ffffff',
      '--statusbar': '#ffffff'
    },
    editor: {
      bg: '#ffffff',
      text: '#000000',
      gutters: '#ffffff',
      gutterBorder: '#000000',
      linenumber: '#000000',
      activeLine: '#f0f0f0',
      selected: '#add6ff',
      cursor: '#000000',
      keyword: '#0000ff',
      string: '#a31515',
      number: '#098658',
      comment: '#008000',
      def: '#795e26',
      variable: '#000000',
      property: '#000000',
      operator: '#000000',
      atom: '#0000ff',
      punctuation: '#000000'
    }
  },
  'light-modern': {
    isLight: true,
    variables: {
      '--bg': '#ffffff',
      '--bg2': '#f8f8f8',
      '--bg3': '#f8f8f8',
      '--bg4': '#e8e8e8',
      '--bg5': '#d8d8d8',
      '--actbar': '#f8f8f8',
      '--border': '#e8e8e8',
      '--border2': '#d8d8d8',
      '--text': '#3b3b3b',
      '--text2': '#5c5c5c',
      '--text3': '#767676',
      '--hl': '#e4e6f1',
      '--hl2': '#f2f2f2',
      '--blue': '#005fb8',
      '--blue2': '#005fb8',
      '--green': '#f8f8f8',
      '--green2': '#098658',
      '--green3': '#a31515',
      '--mongo': '#ffffff',
      '--statusbar': '#f8f8f8'
    },
    editor: {
      bg: '#ffffff',
      text: '#3b3b3b',
      gutters: '#ffffff',
      gutterBorder: '#e8e8e8',
      linenumber: '#767676',
      activeLine: 'rgba(0,0,0,0.02)',
      selected: '#e4e6f1',
      cursor: '#3b3b3b',
      keyword: '#0000ff',
      string: '#a31515',
      number: '#098658',
      comment: '#008000',
      def: '#795e26',
      variable: '#3b3b3b',
      property: '#3b3b3b',
      operator: '#3b3b3b',
      atom: '#0000ff',
      punctuation: '#3b3b3b'
    }
  },
  'light-plus': {
    isLight: true,
    variables: {
      '--bg': '#ffffff',
      '--bg2': '#f3f3f3',
      '--bg3': '#ffffff',
      '--bg4': '#e5e5e5',
      '--bg5': '#d4d4d4',
      '--actbar': '#2c2c2c',
      '--border': '#e5e5e5',
      '--border2': '#cccccc',
      '--text': '#333333',
      '--text2': '#666666',
      '--text3': '#969696',
      '--hl': '#add6ff',
      '--hl2': '#e4e6f1',
      '--blue': '#007acc',
      '--blue2': '#0000ff',
      '--green': '#f3f3f3',
      '--green2': '#008000',
      '--green3': '#a31515',
      '--mongo': '#ffffff',
      '--statusbar': '#007acc'
    },
    editor: {
      bg: '#ffffff',
      text: '#000000',
      gutters: '#ffffff',
      gutterBorder: '#e5e5e5',
      linenumber: '#767676',
      activeLine: '#f2f7ff',
      selected: '#add6ff',
      cursor: '#000000',
      keyword: '#0000ff',
      string: '#a31515',
      number: '#098658',
      comment: '#008000',
      def: '#795e26',
      variable: '#000000',
      property: '#000000',
      operator: '#000000',
      atom: '#0000ff',
      punctuation: '#000000'
    }
  },
  'monokai': {
    isLight: false,
    variables: {
      '--bg': '#272822',
      '--bg2': '#1e1f1c',
      '--bg3': '#141411',
      '--bg4': '#3e3d32',
      '--bg5': '#49483e',
      '--actbar': '#1e1f1c',
      '--border': '#3e3d32',
      '--border2': '#75715e',
      '--text': '#f8f8f2',
      '--text2': '#a59f85',
      '--text3': '#75715e',
      '--hl': '#49483e',
      '--hl2': '#272822',
      '--blue': '#66d9ef',
      '--blue2': '#a6e22e',
      '--green': '#1e1f1c',
      '--green2': '#a6e22e',
      '--green3': '#f92672',
      '--mongo': '#272822',
      '--statusbar': '#272822'
    },
    editor: {
      bg: '#272822',
      text: '#f8f8f2',
      gutters: '#1e1f1c',
      gutterBorder: '#272822',
      linenumber: '#75715e',
      activeLine: 'rgba(255,255,255,0.03)',
      selected: '#49483e',
      cursor: '#f8f8f0',
      keyword: '#f92672',
      string: '#e6db74',
      number: '#ae81ff',
      comment: '#75715e',
      def: '#a6e22e',
      variable: '#a6e22e',
      property: '#66d9ef',
      operator: '#f92672',
      atom: '#ae81ff',
      punctuation: '#f8f8f2'
    }
  },
  'monokai-dimmed': {
    isLight: false,
    variables: {
      '--bg': '#1e1e1e',
      '--bg2': '#1a1a1a',
      '--bg3': '#121212',
      '--bg4': '#303030',
      '--bg5': '#404040',
      '--actbar': '#1a1a1a',
      '--border': '#2d2d2d',
      '--border2': '#404040',
      '--text': '#c5c8c6',
      '--text2': '#969896',
      '--text3': '#707880',
      '--hl': '#373b41',
      '--hl2': '#1e1e1e',
      '--blue': '#81a2be',
      '--blue2': '#b294bb',
      '--green': '#1a1a1a',
      '--green2': '#b294bb',
      '--green3': '#cc6666',
      '--mongo': '#1e1e1e',
      '--statusbar': '#1a1a1a'
    },
    editor: {
      bg: '#1e1e1e',
      text: '#c5c8c6',
      gutters: '#1a1a1a',
      gutterBorder: '#2d2d2d',
      linenumber: '#707880',
      activeLine: '#252525',
      selected: '#373b41',
      cursor: '#c5c8c6',
      keyword: '#b294bb',
      string: '#b5bd68',
      number: '#de935f',
      comment: '#969896',
      def: '#81a2be',
      variable: '#c5c8c6',
      property: '#81a2be',
      operator: '#8abeb7',
      atom: '#de935f',
      punctuation: '#c5c8c6'
    }
  },
  'powershell-ise': {
    isLight: true,
    variables: {
      '--bg': '#ffffff',
      '--bg2': '#f0f4f9',
      '--bg3': '#e1e9f3',
      '--bg4': '#c9daf0',
      '--bg5': '#b0cce9',
      '--actbar': '#0056b3',
      '--border': '#b0cce9',
      '--border2': '#0056b3',
      '--text': '#000000',
      '--text2': '#0056b3',
      '--text3': '#5f7a99',
      '--hl': '#add6ff',
      '--hl2': '#f0f4f9',
      '--blue': '#0000ff',
      '--blue2': '#0000ff',
      '--green': '#f0f4f9',
      '--green2': '#008000',
      '--green3': '#800000',
      '--mongo': '#ffffff',
      '--statusbar': '#0056b3'
    },
    editor: {
      bg: '#ffffff',
      text: '#000000',
      gutters: '#ffffff',
      gutterBorder: '#b0cce9',
      linenumber: '#000000',
      activeLine: '#eef4fa',
      selected: '#add6ff',
      cursor: '#000000',
      keyword: '#0000ff',
      string: '#800000',
      number: '#0000f0',
      comment: '#008000',
      def: '#0000ff',
      variable: '#000000',
      property: '#000000',
      operator: '#000000',
      atom: '#0000ff',
      punctuation: '#000000'
    }
  },
  'quiet-light': {
    isLight: true,
    variables: {
      '--bg': '#f5f5f5',
      '--bg2': '#edecee',
      '--bg3': '#e4e2e6',
      '--bg4': '#d5d1d9',
      '--bg5': '#c6bfcc',
      '--actbar': '#4a4750',
      '--border': '#d5d1d9',
      '--border2': '#a89eb0',
      '--text': '#333333',
      '--text2': '#706a7c',
      '--text3': '#968fa3',
      '--hl': '#e1d3e8',
      '--hl2': '#edecee',
      '--blue': '#7a3e9d',
      '--blue2': '#448c27',
      '--green': '#edecee',
      '--green2': '#448c27',
      '--green3': '#aa3731',
      '--mongo': '#f5f5f5',
      '--statusbar': '#706a7c'
    },
    editor: {
      bg: '#f5f5f5',
      text: '#333333',
      gutters: '#f5f5f5',
      gutterBorder: '#d5d1d9',
      linenumber: '#968fa3',
      activeLine: '#fdfbfe',
      selected: '#e1d3e8',
      cursor: '#333333',
      keyword: '#7a3e9d',
      string: '#448c27',
      number: '#ab6526',
      comment: '#aaaaaa',
      def: '#aa3731',
      variable: '#333333',
      property: '#333333',
      operator: '#7a3e9d',
      atom: '#7a3e9d',
      punctuation: '#333333'
    }
  },
  'red': {
    isLight: false,
    variables: {
      '--bg': '#3f0000',
      '--bg2': '#2b0000',
      '--bg3': '#1f0000',
      '--bg4': '#5a0000',
      '--bg5': '#7f0000',
      '--actbar': '#1f0000',
      '--border': '#5a0000',
      '--border2': '#9e0000',
      '--text': '#ffe0e0',
      '--text2': '#ff9999',
      '--text3': '#cc6666',
      '--hl': '#7f0000',
      '--hl2': '#3f0000',
      '--blue': '#ff5555',
      '--blue2': '#ffd700',
      '--green': '#2b0000',
      '--green2': '#ffd700',
      '--green3': '#ff5555',
      '--mongo': '#3f0000',
      '--statusbar': '#3f0000'
    },
    editor: {
      bg: '#3f0000',
      text: '#ffe0e0',
      gutters: '#2b0000',
      gutterBorder: '#5a0000',
      linenumber: '#cc6666',
      activeLine: '#4f0000',
      selected: '#7f0000',
      cursor: '#ffe0e0',
      keyword: '#ff5555',
      string: '#ffd700',
      number: '#ff9999',
      comment: '#995555',
      def: '#ff9999',
      variable: '#ffe0e0',
      property: '#ffe0e0',
      operator: '#ff5555',
      atom: '#ff5555',
      punctuation: '#ffe0e0'
    }
  },
  'solarized-dark': {
    isLight: false,
    variables: {
      '--bg': '#002b36',
      '--bg2': '#073642',
      '--bg3': '#00212b',
      '--bg4': '#586e75',
      '--bg5': '#93a1a1',
      '--actbar': '#00212b',
      '--border': '#073642',
      '--border2': '#586e75',
      '--text': '#839496',
      '--text2': '#93a1a1',
      '--text3': '#586e75',
      '--hl': '#274642',
      '--hl2': '#073642',
      '--blue': '#268bd2',
      '--blue2': '#2aa198',
      '--green': '#073642',
      '--green2': '#859900',
      '--green3': '#dc322f',
      '--mongo': '#002b36',
      '--statusbar': '#002b36'
    },
    editor: {
      bg: '#002b36',
      text: '#839496',
      gutters: '#073642',
      gutterBorder: '#073642',
      linenumber: '#586e75',
      activeLine: 'rgba(255,255,255,0.03)',
      selected: '#274642',
      cursor: '#839496',
      keyword: '#859900',
      string: '#2aa198',
      number: '#d33682',
      comment: '#586e75',
      def: '#268bd2',
      variable: '#268bd2',
      property: '#2aa198',
      operator: '#859900',
      atom: '#b58900',
      punctuation: '#839496'
    }
  }
};
function loadSettingsFromLocalStorage() {
  const defaults = {
    themeName: 'dark-2026',
    fontFamily: 'Consolas',
    fontSizeVal: 11,
    fontSizeUnit: 'pt',
    tabWidth: '4 spaces',
    maxResults: 10000,
    timeout: '30 s'
  };
  const saved = JSON.parse(localStorage.getItem('mongosandbox_settings') || '{}');
  S.settings = { ...defaults, ...saved };
  
  // Backwards compatibility for old S.settings.fontSize (e.g. "13 pt")
  if (saved.fontSize && !saved.fontSizeVal) {
    const valMatch = String(saved.fontSize).match(/\d+/);
    const unitMatch = String(saved.fontSize).match(/[a-zA-Z]+/);
    S.settings.fontSizeVal = valMatch ? parseInt(valMatch[0]) : 13;
    S.settings.fontSizeUnit = unitMatch ? unitMatch[0] : 'pt';
  }
  
  // Populate modal inputs
  const themeSelect = document.getElementById('set-theme-name');
  if (themeSelect) themeSelect.value = S.settings.themeName;

  document.getElementById('set-font-family').value = S.settings.fontFamily;
  document.getElementById('set-font-size-val').value = S.settings.fontSizeVal;
  document.getElementById('set-font-size-unit').value = S.settings.fontSizeUnit;
  document.getElementById('set-tab-width').value = S.settings.tabWidth;
  document.getElementById('set-max-results').value = S.settings.maxResults;
  document.getElementById('set-timeout').value = S.settings.timeout;
}

function saveSettings() {
  const themeSelect = document.getElementById('set-theme-name');
  if (themeSelect) S.settings.themeName = themeSelect.value;

  S.settings.fontFamily = document.getElementById('set-font-family').value;
  S.settings.fontSizeVal = parseInt(document.getElementById('set-font-size-val').value) || 11;
  S.settings.fontSizeUnit = document.getElementById('set-font-size-unit').value;
  S.settings.tabWidth = document.getElementById('set-tab-width').value;
  S.settings.maxResults = parseInt(document.getElementById('set-max-results').value) || 10000;
  S.settings.timeout = document.getElementById('set-timeout').value;
  
  // Maintain S.settings.fontSize for older dependencies
  S.settings.fontSize = S.settings.fontSizeVal + S.settings.fontSizeUnit;
  
  localStorage.setItem('mongosandbox_settings', JSON.stringify(S.settings));
  applySettings();
  closeModal('settings-modal');
  logOutput('[info] Editor and execution settings saved.');
}

function applyThemeColors(themeName) {
  const theme = THEMES[themeName] || THEMES['dark-2026'];
  
  // 1. Set CSS variables on root
  for (const [key, val] of Object.entries(theme.variables)) {
    document.documentElement.style.setProperty(key, val);
  }
  
  // 2. Adjust modal backgrounds/inputs if light theme
  const selects = document.querySelectorAll('.setting-group select, .setting-group input, .modal-body input, .modal-body select');
  if (theme.isLight) {
    document.body.classList.add('light-theme');
    selects.forEach(el => {
      el.style.background = '#ffffff';
      el.style.color = '#000000';
      el.style.borderColor = '#cccccc';
    });
    // Settings modal bg
    const settingsModalBody = document.querySelector('#settings-modal .modal-body');
    if (settingsModalBody) settingsModalBody.style.background = '#fafafa';
  } else {
    document.body.classList.remove('light-theme');
    selects.forEach(el => {
      el.style.background = '#2d2d2d';
      el.style.color = '#ffffff';
      el.style.borderColor = '#3c3c3c';
    });
    // Settings modal bg
    const settingsModalBody = document.querySelector('#settings-modal .modal-body');
    if (settingsModalBody) settingsModalBody.style.background = '#1e1e1e';
  }

  // 3. Inject editor CSS styles dynamically
  let themeStyleEl = document.getElementById('cm-dyn-theme-style');
  if (!themeStyleEl) {
    themeStyleEl = document.createElement('style');
    themeStyleEl.id = 'cm-dyn-theme-style';
    document.head.appendChild(themeStyleEl);
  }
  
  const ed = theme.editor;
  themeStyleEl.textContent = `
    .CodeMirror { background: ${ed.bg} !important; color: ${ed.text} !important; }
    .CodeMirror-gutters { background: ${ed.gutters || ed.bg} !important; border-right: 1px solid ${ed.gutterBorder || 'var(--border)'} !important; }
    .CodeMirror-linenumber { color: ${ed.linenumber || 'var(--text3)'} !important; }
    .CodeMirror-activeline-background { background: ${ed.activeLine || 'rgba(255,255,255,0.03)'} !important; }
    .CodeMirror-selected { background: ${ed.selected || 'var(--hl)'} !important; }
    .CodeMirror-cursor { border-left: 2px solid ${ed.cursor || 'var(--text)'} !important; }
    .cm-keyword { color: ${ed.keyword} !important; font-weight: bold; }
    .cm-string, .cm-string-2 { color: ${ed.string} !important; }
    .cm-number { color: ${ed.number} !important; }
    .cm-comment { color: ${ed.comment} !important; font-style: italic; }
    .cm-property { color: ${ed.property || ed.text} !important; }
    .cm-variable { color: ${ed.variable || ed.text} !important; }
    .cm-variable-2 { color: ${ed.variable2 || ed.variable || ed.text} !important; }
    .cm-def { color: ${ed.def || ed.text} !important; font-weight: bold; }
    .cm-operator { color: ${ed.operator || ed.text} !important; }
    .cm-atom { color: ${ed.atom || ed.keyword} !important; }
    .cm-punctuation { color: ${ed.punctuation || ed.text} !important; }
    .CodeMirror-scroll { background: ${ed.bg} !important; }
    .CodeMirror-hints { background: ${theme.variables['--bg2']}; border: 1px solid ${theme.variables['--border2']}; z-index: 1000; }
    .CodeMirror-hint { color: ${theme.variables['--text']}; }
    .CodeMirror-hint-active { background: ${theme.variables['--hl']} !important; color: #fff; }
  `;
}

function applySettings() {
  if (!editor) return;
  
  // Extract number from tabWidth (e.g. "4 spaces" -> 4)
  const tabMatch = String(S.settings.tabWidth || '4').match(/\d+/);
  const tabVal = tabMatch ? parseInt(tabMatch[0]) : 4;
  editor.setOption('tabSize', tabVal);
  editor.setOption('indentUnit', tabVal);
  
  // Apply styling dynamically (fontFamily, fontSize)
  let styleEl = document.getElementById('cm-dyn-settings-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'cm-dyn-settings-style';
    document.head.appendChild(styleEl);
  }
  
  const sizeVal = (S.settings.fontSizeVal || 11) + (S.settings.fontSizeUnit || 'pt');
  
  styleEl.textContent = `
    .CodeMirror,
    .CodeMirror pre.CodeMirror-line,
    .CodeMirror pre.CodeMirror-line-like,
    .CodeMirror-linenumber,
    .CodeMirror-lines * {
      font-family: ${S.settings.fontFamily || 'Consolas'}, 'JetBrains Mono', monospace !important;
      font-size: ${sizeVal} !important;
    }
  `;

  // Apply application theme CSS variables & CodeMirror theme overrides dynamically!
  applyThemeColors(S.settings.themeName || 'dark-2026');
  
  editor.refresh();
}
