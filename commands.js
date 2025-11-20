// commands.js
// AdminShell COMMANDS for xterm.js environment
// Expects globals: term, TERMINAL_API_URL, currentRole, switchRole, promptPassword (script.js provides)
// This file defines window.COMMANDS

(function () {
  // محلية
  let currentPath = '';

  function normalizePath(base, target) {
    if (!target) return base || '';
    if (target.startsWith('/')) target = target.slice(1);
    const baseParts = (base || '').split('/').filter(Boolean);
    const segs = target.split('/').filter(Boolean);
    const stack = [...baseParts];
    for (const s of segs) {
      if (s === '.') continue;
      if (s === '..') stack.pop();
      else stack.push(s);
    }
    return stack.join('/');
  }

  function splitPathComponents(path) {
    return (path || '').split('/').filter(Boolean);
  }

  function isProtectedPath(path) {
    if (!path) return false;
    const parts = splitPathComponents(path);
    for (const p of parts) {
      const low = p.toLowerCase();
      if (low.includes('root') || low.includes('admin')) return true;
    }
    return false;
  }

  async function apiFetch(action, path, options = {}) {
    try {
      // إذا action يتطلب POST مع بيانات (create/update) نرسل JSON body
      if ((action === 'create' || action === 'update') && options.data !== undefined) {
        const res = await fetch(TERMINAL_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, path, data: options.data })
        });
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) return await res.json();
        return await res.text();
      } else {
        const u = new URL(TERMINAL_API_URL);
        u.searchParams.set('action', action);
        u.searchParams.set('path', path || '');
        const res = await fetch(u.toString());
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) return await res.json();
        const txt = await res.text();
        try { return JSON.parse(txt); } catch { return txt; }
      }
    } catch (e) {
      return { ok: false, msg: 'Network/API error: ' + e.message };
    }
  }

  // formater
  function formatListEntries(entries, flags) {
    const lines = [];
    if (!Array.isArray(entries)) return lines;
    for (const e of entries) {
      const isFolder = e.mimeType === 'folder' || e.mimeType === 'application/vnd.google-apps.folder';
      let name = isFolder ? `📂 [${e.name}]` : `📄 ${e.name}`;
      if (flags.id) name += ` | 🆔 ${e.id || ''}`;
      if (flags.url) name += ` | 🔗 ${e.url || ''}`;
      lines.push({ text: name, meta: e, isFolder });
    }
    return lines;
  }

  function applyFilters(listItems, flags, searchTerm) {
    return listItems.filter(e => {
      const n = e.meta.name.toLowerCase();
      if (flags.filesOnly && e.isFolder) return false;
      if (flags.txt && !n.endsWith('.txt')) return false;
      if (flags.js && !n.endsWith('.js')) return false;
      if (flags.doc && !(n.endsWith('.doc') || n.endsWith('.docx'))) return false;
      if (flags.pdf && !n.endsWith('.pdf')) return false;
      if (flags.json && !n.endsWith('.json')) return false;
      if (searchTerm && !n.includes(searchTerm.toLowerCase())) return false;
      return true;
    });
  }

  async function buildTree(path, flags, indent = '', visited = new Set(), roleFilter = 'user') {
    if (isProtectedPath(path) && roleFilter !== 'root') return [`❌ This path requires root privileges: /${path}`];
    const raw = await apiFetch('list', path);
    if (!Array.isArray(raw)) return [`❌ Failed to list path: /${path}`];
    // filter protected children for non-root
    const entries = raw.filter(e => {
      if (roleFilter !== 'root') {
        if (isProtectedPath(path ? `${path}/${e.name}` : e.name)) return false;
      }
      return true;
    });
    const formatted = formatListEntries(entries, flags);
    const filtered = applyFilters(formatted, flags, flags.searchTerm || null);
    let lines = [];
    for (const item of filtered) {
      lines.push(indent + item.text);
      if (item.isFolder && flags.all) {
        const subPath = path ? `${path}/${item.meta.name}` : item.meta.name;
        if (visited.has(subPath)) continue;
        visited.add(subPath);
        const sub = await buildTree(subPath, flags, indent + '  ', visited, roleFilter);
        lines = lines.concat(sub);
      }
    }
    return lines;
  }

  const commands = {};

  commands.help = {
    description: 'عرض جميع الأوامر المتاحة',
    action: async ({ role }) => {
      return Object.keys(commands)
        .filter(k => { const c = commands[k]; if (c.restricted && role === 'user') return false; return true; })
        .map(k => `• ${k} - ${commands[k].description}`)
        .join('\n');
    }
  };

  commands.whoami = {
    description: 'إظهار الدور الحالي والمسار',
    action: async ({ role }) => `role=${role} | path=/${currentPath}`
  };

  commands.sudo = {
    description: 'رفع الصلاحية إلى admin (sudo su)',
    action: async ({ args }) => {
      if (args[0] === 'su') {
        await switchRole('admin'); // script.js handles password prompt
        return `🔓 Attempted switch to admin (use whoami to confirm)`;
      }
      return 'Usage: sudo su';
    }
  };

  commands.su = {
    description: 'رفع الصلاحية إلى root (su root) — requires admin first',
    action: async ({ args }) => {
      if (args[0] === 'root') {
        await switchRole('root');
        return `🔱 Attempted switch to root (use whoami to confirm)`;
      }
      return 'Usage: su root';
    }
  };

  commands.exit = {
    description: 'العودة إلى user',
    action: async ({ role }) => {
      if (role === 'admin' || role === 'root') {
        await switchRole('user');
        return '🔒 Returned to user privileges.';
      } else return '❗ أنت بالفعل مستخدم عادي.';
    }
  };

  commands.echo = {
    description: 'إعادة النص كما هو',
    action: async ({ args }) => args.join(' ')
  };

  commands.cd = {
    description: 'تغيير المجلد الحالي (cd <path>)',
    restricted: true,
    action: async ({ role, args }) => {
      if (role === 'user') return '❌ Insufficient privileges.';
      const target = args[0] || '';
      const newPath = normalizePath(currentPath, target);
      const res = await apiFetch('list', newPath);
      if (!Array.isArray(res)) return `❌ Folder not found: ${target}`;
      if (isProtectedPath(newPath) && role !== 'root') return '❌ This path requires root privileges.';
      currentPath = newPath;
      return `📂 Current path: /${currentPath || ''}`;
    }
  };

  commands.mkdir = {
    description: 'إنشاء مجلد: mkdir <name|path>',
    restricted: true,
    action: async ({ role, args }) => {
      if (role === 'user') return '❌ Insufficient privileges.';
      const name = args[0];
      if (!name) return 'Usage: mkdir <folderName> or mkdir <path/to/folder>';
      const target = normalizePath(currentPath, name);
      if (isProtectedPath(target) && role !== 'root') return '❌ Cannot create protected folder without root.';
      const res = await apiFetch('mkdir', target);
      if (res && res.ok) return `✅ Folder created: /${target}`;
      return `❌ Failed to create folder: ${res && res.msg ? res.msg : 'unknown error'}`;
    }
  };

  commands.create = {
    description: 'إنشاء ملف فارغ: create <path/filename>',
    restricted: true,
    action: async ({ role, args }) => {
      if (role === 'user') return '❌ Insufficient privileges.';
      const path = args[0];
      if (!path) return 'Usage: create <path/filename>';
      const full = normalizePath(currentPath, path);
      if (isProtectedPath(full) && role !== 'root') return '❌ Cannot create inside protected path.';
      const res = await apiFetch('create', full, { data: '' });
      if (res && res.ok) return `✅ File created: /${full}`;
      return `❌ Failed to create file: ${res && res.msg ? res.msg : 'unknown error'}`;
    }
  };

  commands.update = {
    description: 'تحديث/إنشاء ملف مع محتوى: update <path> <content...>',
    restricted: true,
    action: async ({ role, args, rawInput }) => {
      if (role === 'user') return '❌ Insufficient privileges.';
      const [path] = args;
      if (!path) return 'Usage: update <path/filename> <content>';
      const idx = rawInput.indexOf(path);
      const content = rawInput.slice(idx + path.length).trim();
      const full = normalizePath(currentPath, path);
      if (isProtectedPath(full) && role !== 'root') return '❌ Cannot update protected path.';
      const res = await apiFetch('update', full, { data: content });
      if (res && res.ok) return `✅ File updated: /${full}`;
      // fallback create
      const cr = await apiFetch('create', full, { data: content });
      if (cr && cr.ok) return `✅ File created: /${full}`;
      return `❌ Failed to update file: ${res && res.msg ? res.msg : 'unknown error'}`;
    }
  };

  commands.read = {
    description: 'قراءة ملف: read <path/filename>',
    restricted: true,
    action: async ({ role, args }) => {
      if (role === 'user') return '❌ Insufficient privileges.';
      const path = args[0];
      if (!path) return 'Usage: read <path/filename>';
      const full = normalizePath(currentPath, path);
      if (isProtectedPath(full) && role !== 'root') return '❌ Cannot read protected path.';
      const res = await apiFetch('read', full);
      if (res && res.ok && typeof res.data === 'string') return res.data;
      if (typeof res === 'string') return res;
      return `❌ Failed to read: ${res && res.msg ? res.msg : 'unknown error'}`;
    }
  };

  commands.delete = {
    description: 'حذف ملف/مجلد فارغ: delete <path>',
    restricted: true,
    action: async ({ role, args }) => {
      if (role === 'user') return '❌ Insufficient privileges.';
      const path = args[0];
      if (!path) return 'Usage: delete <path>';
      const full = normalizePath(currentPath, path);
      if (isProtectedPath(full) && role !== 'root') return '❌ Cannot delete protected path.';
      const res = await apiFetch('delete', full);
      if (res && res.ok) return `✅ Deleted: /${full}`;
      return `❌ Failed to delete (maybe folder not empty or not exists)`;
    }
  };

  commands.list = {
    description: 'عرض الملفات والمجلدات: list [path|search] [--all] [--txt|--js|--pdf|--json] [-id] [-url] [-n(files only)]',
    restricted: true,
    action: async ({ role, args, flags }) => {
      if (role === 'user') return '❌ Insufficient privileges.';
      flags = flags || {};
      const filterFlags = {
        all: !!flags.all,
        txt: !!flags.txt,
        js: !!flags.js,
        doc: !!flags.doc,
        pdf: !!flags.pdf,
        json: !!flags.json,
        id: !!flags.id,
        url: !!flags.url,
        filesOnly: !!flags.n
      };
      let targetPath = currentPath;
      let searchTerm = null;
      if (args.length > 0) {
        const first = args[0];
        if (first.includes('/') || first.startsWith('/')) {
          targetPath = normalizePath(currentPath, first);
          if (args[1]) searchTerm = args[1];
        } else {
          const possible = normalizePath(currentPath, first);
          const existsResp = await apiFetch('list', possible);
          if (Array.isArray(existsResp)) {
            targetPath = possible;
            if (args[1]) searchTerm = args[1];
          } else {
            searchTerm = first;
            if (args[1]) {
              const maybePath = normalizePath(currentPath, args[1]);
              const r2 = await apiFetch('list', maybePath);
              if (Array.isArray(r2)) targetPath = maybePath;
            }
          }
        }
      }
      filterFlags.searchTerm = searchTerm;
      if (isProtectedPath(targetPath) && role !== 'root') return '❌ This path requires root privileges.';
      const lines = await buildTree(targetPath, filterFlags, '', new Set(), role);
      return lines.join('\n') || '📁 No files or folders found.';
    }
  };

  // startpaste now uses client-side editor handler if available
  commands.startpaste = {
    description: 'Start multi-line edit: startpaste <path/to/file>  (finish with #@/s~ to save, #@/c~ to cancel)',
    restricted: true,
    action: async ({ role, args }) => {
      if (role === 'user') return '❌ Insufficient privileges.';
      const p = args[0];
      if (!p) return 'Usage: startpaste <path/to/file>';
      const full = normalizePath(currentPath, p);
      if (isProtectedPath(full) && role !== 'root') return '❌ Cannot edit protected path.';
      // if client exposes enterEditor, use it
      if (typeof window.enterEditor === 'function') {
        window.enterEditor(full, role);
        return `✍️ Editor opened for /${full}\nType lines normally. End with '#@/s~' to save or '#@/c~' to cancel.`;
      } else {
        // fallback: emulate old method - instruct user to use . prefix
        return '⚠️ Editor not available in this client. Use the dot-prefix paste mode: . <line> per line, .save or .cancel';
      }
    }
  };

  // convenience alias
  commands.ls = { description: 'alias list', action: async (ctx) => commands.list.action(ctx) };

  commands.find = {
    description: 'بحث بسيط: find <name> [path]',
    restricted: true,
    action: async ({ role, args }) => {
      if (role === 'user') return '❌ Insufficient privileges.';
      const name = args[0];
      if (!name) return 'Usage: find <name> [startPath]';
      const start = args[1] ? normalizePath(currentPath, args[1]) : currentPath;
      if (isProtectedPath(start) && role !== 'root') return '❌ This path requires root privileges.';
      const q = [start];
      const found = [];
      while (q.length) {
        const p = q.shift();
        const items = await apiFetch('list', p);
        if (!Array.isArray(items)) continue;
        for (const it of items) {
          const childPath = p ? `${p}/${it.name}` : it.name;
          if (it.name.toLowerCase().includes(name.toLowerCase())) found.push(childPath);
          if (it.mimeType === 'folder' || it.mimeType === 'application/vnd.google-apps.folder') q.push(childPath);
        }
        if (found.length >= 100) break;
      }
      return found.length ? found.join('\n') : 'No matches found.';
    }
  };

  commands.addcmd = {
    description: 'إضافة أمر جديد (addcmd name restricted(true|false))',
    restricted: true,
    action: async ({ role, args }) => {
      if (role !== 'admin' && role !== 'root') return '❌ Only admin/root can add commands.';
      const name = args[0];
      const restricted = args[1] === 'true';
      if (!name) return 'Usage: addcmd <name> <restricted:true|false>';
      commands[name] = { description: 'User added command', restricted, action: async () => `✅ ${name} executed` };
      return `✅ Command added: ${name}`;
    }
  };

  commands.vfsreset = {
    description: 'طلب إعادة تهيئة VFS (root only)',
    restricted: true,
    action: async ({ role }) => {
      if (role !== 'root') return '❌ Requires root.';
      const res = await apiFetch('vfsreset', '');
      if (res && res.ok) return '✅ Reset requested (server-side).';
      return '⚠️ Reset request sent (no confirmation).';
    }
  };

  // help for editor
  commands.pastehelp = {
    description: 'شرح محرر: startpaste + نهاية #@/s~ أو #@/c~',
    action: async () => {
      return [
        'Start editor: startpaste path/to/file',
        "Type lines normally (no prefix needed).",
        "End / save:  #@/s~",
        "Cancel:      #@/c~",
        "This editor works on both mobile and desktop."
      ].join('\n');
    }
  };

  window.COMMANDS = commands;
})();