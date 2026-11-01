import { useState, useRef, useEffect } from 'react'
import {
  Folder, Code2, Search, Settings, CloudUpload, CloudDownload, Menu, Sparkles,
  Send, X, FileJson, FileCode2, Plus, Save, Check, RefreshCw,
  Cloud, Cpu, Key, FileText, ChevronRight, Zap, Copy, LogIn, LogOut, Trash2,
  Edit3, FolderPlus, FilePlus, CheckSquare, Square, Home, ArrowLeft, MoreVertical, Brain
} from 'lucide-react'
import { useGoogleLogin } from '@react-oauth/google'
import ReactMarkdown from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import * as acorn from 'acorn'
import jsx from 'acorn-jsx'
const ASTParser = acorn.Parser.extend(jsx())
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import EditorImport from 'react-simple-code-editor'
import Prism from 'prismjs'
import 'prismjs/components/prism-clike'
import 'prismjs/components/prism-javascript'
import 'prismjs/components/prism-css'
import 'prismjs/components/prism-markup'
import 'prismjs/themes/prism-tomorrow.css'

const Editor = EditorImport.default || EditorImport;
import { listDriveFiles, listDriveFilesRecursive, ensurePathInDrive, readDriveFile, writeDriveFile, setupWorkspaceFolder, deleteDriveFile, findOrCreateFolder, listProjectFolders, renameDriveItem, getChatsFolder } from './gdrive'
import './App.css'

// Sample initial project files (Synced with Cloud)
const INITIAL_FILES = {
  'App.jsx': `import React, { useState } from 'react';

export default function AntigravityApp() {
  const [status, setStatus] = useState('Online');

  return (
    <div className="container">
      <h1>Quanta Mobile IDE</h1>
      <p>Status: {status}</p>
      <button onClick={() => setStatus('Synced')}>Sync Drive</button>
    </div>
  );
}`,
  'index.css': `body {
  margin: 0;
  padding: 0;
  font-family: sans-serif;
  background-color: #0b0e14;
  color: #fff;
}`,
  'utils.js': `// Helper functions for cloud data transformation
export function formatBytes(bytes, decimals = 2) {
  if (!bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}`,
  'package.json': `{
  "name": "quanta-mobile-ide",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "react": "^18.2.0",
    "lucide-react": "^0.300.0"
  }
}`
}

function App() {
  // Navigation & File States
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem('activeTab') || 'files') // 'files', 'code', 'search', 'settings'
  const [files, setFiles] = useState(() => {
    const saved = localStorage.getItem('quantaFiles');
    return saved ? JSON.parse(saved) : INITIAL_FILES;
  })
  const [openTabs, setOpenTabs] = useState(() => {
    const saved = localStorage.getItem('openTabs');
    return saved ? JSON.parse(saved) : ['App.jsx', 'utils.js'];
  })
  const [activeFile, setActiveFile] = useState(() => localStorage.getItem('activeFile') || 'App.jsx')
  const [syntaxError, setSyntaxError] = useState(null)
  const [syncProgress, setSyncProgress] = useState(0)
  const [editorContent, setEditorContent] = useState(() => {
    const savedFiles = localStorage.getItem('quantaFiles');
    const parsedFiles = savedFiles ? JSON.parse(savedFiles) : INITIAL_FILES;
    const active = localStorage.getItem('activeFile') || 'App.jsx';
    return parsedFiles[active] !== undefined ? parsedFiles[active] : (parsedFiles['App.jsx'] || '');
  })

  // Persist State to Local Storage
  useEffect(() => { localStorage.setItem('activeTab', activeTab); }, [activeTab]);
  useEffect(() => { localStorage.setItem('quantaFiles', JSON.stringify(files)); }, [files]);
  useEffect(() => { localStorage.setItem('openTabs', JSON.stringify(openTabs)); }, [openTabs]);
  useEffect(() => { localStorage.setItem('activeFile', activeFile); }, [activeFile]);

  const lineNumbersRef = useRef(null)
  const textareaRef = useRef(null)

  const handleScroll = (e) => {
    if (lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = e.target.scrollTop
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const start = e.target.selectionStart
      const end = e.target.selectionEnd
      const val = e.target.value
      const newVal = val.substring(0, start) + '  ' + val.substring(end)
      setEditorContent(newVal)

      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = textareaRef.current.selectionEnd = start + 2
        }
      }, 0)
    }
  }

  // Search State
  const [searchQuery, setSearchQuery] = useState('')

  // Settings States
  const [gdriveSynced, setGdriveSynced] = useState(() => !!localStorage.getItem('googleToken'))
  const [googleToken, setGoogleToken] = useState(() => localStorage.getItem('googleToken'))
  const [driveFilesMeta, setDriveFilesMeta] = useState({})
  const [isSyncing, setIsSyncing] = useState(false)
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem('selectedModel') || 'gemini-2.5-flash')
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('geminiApiKey') || import.meta.env.VITE_GEMINI_API_KEY || '')

  useEffect(() => {
    localStorage.setItem('geminiApiKey', apiKey)
    localStorage.setItem('selectedModel', selectedModel)
  }, [apiKey, selectedModel])

  const [currentProject, setCurrentProject] = useState(() => localStorage.getItem('currentProject') || 'Quanta-Mobile-IDE')
  const [isLauncherOpen, setIsLauncherOpen] = useState(() => !localStorage.getItem('currentProject'))
  const [newProjectInput, setNewProjectInput] = useState('')
  const [recentProjects, setRecentProjects] = useState(() => {
    const saved = localStorage.getItem('recentProjects')
    return saved ? JSON.parse(saved) : ['Quanta-Mobile-IDE', 'Mobile-Dashboard', 'Antigravity-Bot']
  })

  // Folder ID for active project
  const [workspaceId, setWorkspaceId] = useState(() => {
    const proj = localStorage.getItem('currentProject') || 'Quanta-Mobile-IDE';
    return localStorage.getItem(`workspaceId_${proj}`) || null;
  })

  useEffect(() => { if (workspaceId && currentProject) localStorage.setItem(`workspaceId_${currentProject}`, workspaceId); }, [workspaceId, currentProject]);

  // Custom Modal & Dropdown UI States
  const [isAddDropdownOpen, setIsAddDropdownOpen] = useState(false)
  const [createModalType, setCreateModalType] = useState(null) // 'file' | 'folder'
  const [createItemName, setCreateItemName] = useState('')
  const [itemToDelete, setItemToDelete] = useState(null)

  // Directory & Pterodactyl IDE File Manager States
  const [currentFolderPath, setCurrentFolderPath] = useState([]) // e.g. ['src', 'components']
  const [selectedItems, setSelectedItems] = useState([]) // Array of full relative paths selected
  const [itemToRename, setItemToRename] = useState(null) // { item, newName }
  const [folderSearchQuery, setFolderSearchQuery] = useState('')
  const [isBulkDeleteModalOpen, setIsBulkDeleteModalOpen] = useState(false)

  useEffect(() => { if (workspaceId) localStorage.setItem('workspaceId', workspaceId); }, [workspaceId]);

  // Toast Notification
  const [toastMessage, setToastMessage] = useState(null)

  // AI Chat States
  const [isChatOpen, setIsChatOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState(() => {
    const saved = localStorage.getItem(`quantaChats_${currentProject}`);
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error("Failed to parse chat messages:", e);
      }
    }
    return [{
      id: 1,
      sender: 'assistant',
      text: "👋 Welcome! I am your **Antigravity AI Agent**.\nI am connected to your Google Drive workspace. Ask me to refactor code, generate functions, or optimize logic!",
      suggestedCode: null
    }];
  })

  useEffect(() => {
    const cleanedMessages = chatMessages.map(msg => ({
      ...msg,
      actions: msg.actions ? msg.actions.map(a => a.status ? { ...a, content: undefined } : a) : undefined
    }));
    localStorage.setItem(`quantaChats_${currentProject}`, JSON.stringify(cleanedMessages));
  }, [chatMessages, currentProject]);
  const [inputPrompt, setInputPrompt] = useState('')
  const [isThinking, setIsThinking] = useState(false)

  const chatEndRef = useRef(null)

  // Show Toast Helper
  const showToast = (msg) => {
    setToastMessage(msg)
    setTimeout(() => setToastMessage(null), 3000)
  }

  // Google Drive Sync functions
  const loginWithGoogle = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      const token = tokenResponse.access_token;
      setGoogleToken(token);
      localStorage.setItem('googleToken', token);
      setGdriveSynced(true);
      showToast('Google Drive connected!');

      // Discover existing project folders in Drive
      try {
        const driveProjects = await listProjectFolders(token);
        if (driveProjects && driveProjects.length > 0) {
          const names = driveProjects.map(p => p.name);
          setRecentProjects(prev => Array.from(new Set([...names, ...prev])));
        }
      } catch (err) {
        console.error(err);
      }

      await fetchWorkspaceFromDrive(token, currentProject);
    },
    scope: 'https://www.googleapis.com/auth/drive',
  });

  const fetchWorkspaceFromDrive = async (token, projectName = currentProject) => {
    showToast(`Setting up ${projectName} workspace...`);
    try {
      const folderId = await setupWorkspaceFolder(token, projectName);
      setWorkspaceId(folderId);
      localStorage.setItem(`workspaceId_${projectName}`, folderId);

      showToast(`Syncing ${projectName} from Drive...`);
      const driveFiles = await listDriveFilesRecursive(token, folderId);
      const newFiles = {};
      const newMeta = {};

      for (const f of driveFiles) {
        // Simple filter for text-like files for the IDE
        if (f.mimeType === 'text/plain' || f.name.includes('.')) {
          try {
            const content = await readDriveFile(token, f.id);
            newFiles[f.name] = content;
            newMeta[f.name] = f.id;
          } catch (e) {
            console.error('Error reading file:', f.name, e);
          }
        }
      }

      setFiles(newFiles);
      setDriveFilesMeta(newMeta);

      try {
        // Also pull chats for this project
        const chatsFolderId = await getChatsFolder(token);
        const chatFiles = await listDriveFilesRecursive(token, chatsFolderId);
        const chatFile = chatFiles.find(f => f.name === `${projectName}_chats.json`);
        if (chatFile) {
          const chatContent = await readDriveFile(token, chatFile.id);
          const parsedChats = JSON.parse(chatContent);
          setChatMessages(parsedChats);
        }
      } catch (err) {
        console.error("Failed to fetch project chats from Drive:", err);
      }

      showToast('Workspace synced!');
    } catch (error) {
      showToast('Failed to sync from Drive.');
      console.error(error);
    }
  };

  // Select / Open Project
  const handleSelectProject = async (projectName) => {
    if (!projectName || !projectName.trim()) return;
    const cleanName = projectName.trim();

    setCurrentProject(cleanName);
    localStorage.setItem('currentProject', cleanName);

    const savedFolder = localStorage.getItem(`workspaceId_${cleanName}`);
    setWorkspaceId(savedFolder || null);

    if (!recentProjects.includes(cleanName)) {
      const updated = [cleanName, ...recentProjects];
      setRecentProjects(updated);
      localStorage.setItem('recentProjects', JSON.stringify(updated));
    }

    setIsLauncherOpen(false);
    showToast(`Project: ${cleanName}`);

    if (gdriveSynced && googleToken) {
      await fetchWorkspaceFromDrive(googleToken, cleanName);
    }
  };

  // Syntax Validator
  useEffect(() => {
    if (!activeFile) {
      setSyntaxError(null)
      return
    }
    const ext = activeFile.split('.').pop()
    if (ext !== 'js' && ext !== 'jsx') {
      setSyntaxError(null)
      return
    }

    const timer = setTimeout(() => {
      try {
        ASTParser.parse(editorContent || '', { ecmaVersion: 'latest', sourceType: 'module' })
        setSyntaxError(null)
      } catch (err) {
        if (err.loc) {
          setSyntaxError({ line: err.loc.line, message: err.message.replace(/ \(\d+:\d+\)$/, '') })
        } else {
          setSyntaxError(null)
        }
      }
    }, 500)

    return () => clearTimeout(timer)
  }, [editorContent, activeFile])

  // Synchronize editor text when switching active file
  useEffect(() => {
    if (activeFile && files[activeFile] !== undefined) {
      setEditorContent(files[activeFile])
    }
  }, [activeFile])

  // Auto-save local state when editorContent changes
  useEffect(() => {
    if (activeFile && files[activeFile] !== undefined && editorContent !== files[activeFile]) {
      setFiles(prev => ({ ...prev, [activeFile]: editorContent }));
    }
  }, [editorContent, activeFile]);

  // Scroll to bottom of chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages, isThinking])

  // Open file in editor tab
  const handleOpenFile = (fileName) => {
    if (!openTabs.includes(fileName)) {
      setOpenTabs([...openTabs, fileName])
    }
    setActiveFile(fileName)
    setActiveTab('code')
  }

  // Close tab
  const handleCloseTab = (e, fileName) => {
    e.stopPropagation()
    const updated = openTabs.filter(t => t !== fileName)
    setOpenTabs(updated)
    if (activeFile === fileName) {
      if (updated.length > 0) {
        setActiveFile(updated[updated.length - 1])
      } else {
        setActiveFile('')
      }
    }
  }

  const handlePushAll = async () => {
    if (!gdriveSynced || !googleToken) {
      showToast("Connect to Google Drive first!");
      return;
    }
    if (isSyncing) return;
    setIsSyncing(true);
    setSyncProgress(10);
    showToast("Pushing to Google Drive...");

    try {
      let targetFolderId = workspaceId;
      if (!targetFolderId) {
        targetFolderId = await setupWorkspaceFolder(googleToken, currentProject);
        setWorkspaceId(targetFolderId);
        localStorage.setItem(`workspaceId_${currentProject}`, targetFolderId);
      }

      const driveFiles = await listDriveFilesRecursive(googleToken, targetFolderId);
      const driveMap = {};
      driveFiles.forEach(f => driveMap[f.name] = f);

      const newMeta = { ...driveFilesMeta };

      const localFilesToPush = Object.entries(files).filter(([p, c]) => !(p.endsWith('/') || c.startsWith('// Folder:')));
      const totalTasks = localFilesToPush.length + driveFiles.length;
      let completedTasks = 0;

      // 1. Upload/Update local files
      for (const [path, content] of localFilesToPush) {
        const fileId = driveMap[path] ? driveMap[path].id : null;
        const folderId = await ensurePathInDrive(googleToken, path, targetFolderId);
        const fileName = path.split('/').pop();
        const result = await writeDriveFile(googleToken, fileName, content, fileId, folderId);
        if (result.id) {
          newMeta[path] = result.id;
        }
        completedTasks++;
        setSyncProgress(10 + Math.floor((completedTasks / totalTasks) * 90));
      }

      // 2. Delete remote files and folders that do not exist locally
      for (const f of driveFiles) {
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          const folderExistsLocally = Object.keys(files).some(p => p.startsWith(f.name) || p === f.name);
          if (!folderExistsLocally) {
            try {
              await deleteDriveFile(googleToken, f.id);
            } catch (e) { console.error('Failed to delete remote folder', e); }
          }
        } else if (f.mimeType === 'text/plain' || f.name.includes('.')) {
          if (files[f.name] === undefined) {
            try {
              await deleteDriveFile(googleToken, f.id);
              delete newMeta[f.name];
            } catch (e) { console.error('Failed to delete remote file', e); }
          }
        }
        completedTasks++;
        setSyncProgress(10 + Math.floor((completedTasks / totalTasks) * 90));
      }

      setDriveFilesMeta(newMeta);

      try {
        // Push chats for this project
        const chatsFolderId = await getChatsFolder(googleToken);
        const chatFiles = await listDriveFilesRecursive(googleToken, chatsFolderId);
        const chatFile = chatFiles.find(f => f.name === `${currentProject}_chats.json`);
        
        const cleanedMessages = chatMessages.map(msg => ({
          ...msg,
          actions: msg.actions ? msg.actions.map(a => a.status ? { ...a, content: undefined } : a) : undefined
        }));

        await writeDriveFile(googleToken, `${currentProject}_chats.json`, JSON.stringify(cleanedMessages), chatFile ? chatFile.id : null, chatsFolderId);
      } catch (err) {
        console.error("Failed to push chats to Drive:", err);
      }

      setSyncProgress(100);
      setTimeout(() => setSyncProgress(0), 1000);
      showToast("Push complete!");
    } catch (e) {
      showToast("Push failed.");
      console.error(e);
      if (e.message && e.message.includes('401')) {
        setGoogleToken(null);
        setGdriveSynced(false);
        localStorage.removeItem('googleToken');
      }
    } finally {
      setIsSyncing(false);
    }
  };

  const handlePullAll = async () => {
    if (!gdriveSynced || !googleToken) {
      showToast("Connect to Google Drive first!");
      return;
    }
    if (isSyncing) return;
    setIsSyncing(true);
    setSyncProgress(10);
    showToast("Pulling from Google Drive...");

    try {
      let targetFolderId = workspaceId;
      if (!targetFolderId) {
        targetFolderId = await setupWorkspaceFolder(googleToken, currentProject);
        setWorkspaceId(targetFolderId);
        localStorage.setItem(`workspaceId_${currentProject}`, targetFolderId);
      }

      const driveFiles = await listDriveFilesRecursive(googleToken, targetFolderId);

      const newFiles = {};
      const newMeta = {};
      const totalTasks = driveFiles.length;
      let completedTasks = 0;

      for (const f of driveFiles) {
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          newFiles[f.name] = `// Folder: ${f.name.slice(0, -1)}`;
        } else if (f.mimeType === 'text/plain' || f.name.includes('.')) {
          try {
            const content = await readDriveFile(googleToken, f.id);
            newFiles[f.name] = content;
            newMeta[f.name] = f.id;
          } catch (e) { console.error(e); }
        }
        completedTasks++;
        setSyncProgress(10 + Math.floor((completedTasks / totalTasks) * 90));
      }

      setFiles(newFiles);
      setDriveFilesMeta(newMeta);

      try {
        // Pull chats for this project
        const chatsFolderId = await getChatsFolder(googleToken);
        const chatFiles = await listDriveFilesRecursive(googleToken, chatsFolderId);
        const chatFile = chatFiles.find(f => f.name === `${currentProject}_chats.json`);
        if (chatFile) {
          const chatContent = await readDriveFile(googleToken, chatFile.id);
          const parsedChats = JSON.parse(chatContent);
          setChatMessages(parsedChats);
        }
      } catch (err) {
        console.error("Failed to fetch project chats from Drive:", err);
      }

      setSyncProgress(100);
      setTimeout(() => setSyncProgress(0), 1000);
      showToast("Pull complete!");
    } catch (e) {
      showToast("Pull failed.");
      console.error(e);
      if (e.message && e.message.includes('401')) {
        setGoogleToken(null);
        setGdriveSynced(false);
        localStorage.removeItem('googleToken');
      }
    } finally {
      setIsSyncing(false);
    }
  };

  // Request Delete file (Open Custom Modal)
  const requestDeleteFile = (e, fileName) => {
    e.stopPropagation();
    setItemToDelete(fileName);
  }

  // Perform Confirm Delete
  const handleConfirmDelete = async () => {
    if (!itemToDelete) return;
    const fileName = itemToDelete;
    setItemToDelete(null);

    if (gdriveSynced && googleToken) {
      showToast(`Deleting ${fileName} from Drive...`);
      try {
        const fileId = driveFilesMeta[fileName];
        if (fileId) {
          await deleteDriveFile(googleToken, fileId);
        }
      } catch (err) {
        showToast(`Failed to delete ${fileName} from Drive`);
        console.error(err);
        return;
      }
    }

    // Update local state
    const newFiles = { ...files };
    delete newFiles[fileName];
    setFiles(newFiles);

    const newMeta = { ...driveFilesMeta };
    delete newMeta[fileName];
    setDriveFilesMeta(newMeta);

    // If it was open, close it
    if (openTabs.includes(fileName)) {
      const updated = openTabs.filter(t => t !== fileName)
      setOpenTabs(updated)
      if (activeFile === fileName) {
        setActiveFile(updated.length > 0 ? updated[updated.length - 1] : '')
      }
    }

    showToast(`Deleted ${fileName}`);
  }

  // Create File or Folder Submit
  const handleCreateSubmit = async (e) => {
    e.preventDefault();
    if (!createItemName || !createItemName.trim()) return;

    const name = createItemName.trim();
    const parentPrefix = currentFolderPath.length > 0 ? currentFolderPath.join('/') + '/' : '';

    if (createModalType === 'file') {
      const fullPath = parentPrefix + name;
      if (files[fullPath] !== undefined) {
        showToast(`File "${name}" already exists!`);
        return;
      }
      setFiles(prev => ({ ...prev, [fullPath]: `// New file: ${name}\n` }));
      setOpenTabs(prev => [...prev, fullPath]);
      setActiveFile(fullPath);
      setActiveTab('code');
      showToast(`Created file ${name}`);
    } else if (createModalType === 'folder') {
      const folderPath = parentPrefix + name + '/';
      const placeholderFile = `${folderPath}index.js`;
      if (files[placeholderFile] !== undefined) {
        showToast(`Folder "${name}" already exists!`);
        return;
      }

      if (gdriveSynced && googleToken && workspaceId) {
        try {
          showToast(`Creating folder ${name} on Drive...`);
          await findOrCreateFolder(googleToken, name, workspaceId);
        } catch (err) {
          console.error(err);
        }
      }

      setFiles(prev => ({ ...prev, [placeholderFile]: `// Folder: ${name}\n` }));
      showToast(`Created folder ${name}`);
    }

    setCreateModalType(null);
    setCreateItemName('');
  }

  // Calculate items in current directory for Pterodactyl File Manager
  const getCurrentDirectoryContents = () => {
    const currentPrefix = currentFolderPath.length > 0 ? currentFolderPath.join('/') + '/' : '';
    const itemsMap = new Map();

    Object.keys(files).forEach((filePath) => {
      if (!filePath.startsWith(currentPrefix)) return;

      const relativePart = filePath.slice(currentPrefix.length);
      if (!relativePart) return;

      const parts = relativePart.split('/');
      if (parts.length > 1) {
        const folderName = parts[0];
        const folderPath = currentPrefix + folderName;
        if (!itemsMap.has(folderName)) {
          itemsMap.set(folderName, {
            name: folderName,
            fullPath: folderPath,
            isDirectory: true,
            size: '--',
            lineCount: '--',
            modified: 'Folder'
          });
        }
      } else {
        const fileName = parts[0];
        const lines = files[filePath].split('\n').length;
        itemsMap.set(fileName, {
          name: fileName,
          fullPath: filePath,
          isDirectory: false,
          size: `${files[filePath].length} B`,
          lineCount: `${lines} lines`,
          modified: 'Synced'
        });
      }
    });

    let items = Array.from(itemsMap.values());
    if (folderSearchQuery.trim()) {
      items = items.filter(item => item.name.toLowerCase().includes(folderSearchQuery.toLowerCase()));
    }

    return items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  // Handle Rename Submit
  const handleRenameSubmit = async (e) => {
    e.preventDefault();
    if (!itemToRename || !itemToRename.newName.trim()) return;

    const { item, newName } = itemToRename;
    const cleanNewName = newName.trim();
    const parentPrefix = currentFolderPath.length > 0 ? currentFolderPath.join('/') + '/' : '';
    const newFullPath = parentPrefix + cleanNewName;

    if (item.isDirectory) {
      const oldPrefix = item.fullPath + '/';
      const newPrefix = newFullPath + '/';
      const updatedFiles = {};
      const updatedMeta = { ...driveFilesMeta };

      Object.keys(files).forEach(path => {
        if (path.startsWith(oldPrefix)) {
          const suffix = path.slice(oldPrefix.length);
          const target = newPrefix + suffix;
          updatedFiles[target] = files[path];
          if (updatedMeta[path]) {
            updatedMeta[target] = updatedMeta[path];
            delete updatedMeta[path];
          }
        } else {
          updatedFiles[path] = files[path];
        }
      });
      setFiles(updatedFiles);
      setDriveFilesMeta(updatedMeta);
      showToast(`Renamed folder to ${cleanNewName}`);
    } else {
      if (files[newFullPath] !== undefined && newFullPath !== item.fullPath) {
        showToast(`File "${cleanNewName}" already exists!`);
        return;
      }

      if (gdriveSynced && googleToken && driveFilesMeta[item.fullPath]) {
        try {
          await renameDriveItem(googleToken, driveFilesMeta[item.fullPath], cleanNewName);
        } catch (err) {
          console.error(err);
        }
      }

      const updatedFiles = { ...files };
      const content = updatedFiles[item.fullPath];
      delete updatedFiles[item.fullPath];
      updatedFiles[newFullPath] = content;
      setFiles(updatedFiles);

      const updatedMeta = { ...driveFilesMeta };
      if (updatedMeta[item.fullPath]) {
        updatedMeta[newFullPath] = updatedMeta[item.fullPath];
        delete updatedMeta[item.fullPath];
      }
      setDriveFilesMeta(updatedMeta);

      if (openTabs.includes(item.fullPath)) {
        setOpenTabs(prev => prev.map(t => t === item.fullPath ? newFullPath : t));
        if (activeFile === item.fullPath) setActiveFile(newFullPath);
      }

      showToast(`Renamed to ${cleanNewName}`);
    }

    setItemToRename(null);
  }

  // Perform Bulk Delete
  const handleBulkDelete = async () => {
    if (selectedItems.length === 0) return;
    setIsBulkDeleteModalOpen(false);

    showToast(`Deleting ${selectedItems.length} items...`);

    const newFiles = { ...files };
    const newMeta = { ...driveFilesMeta };

    for (const itemPath of selectedItems) {
      Object.keys(newFiles).forEach(path => {
        if (path === itemPath || path.startsWith(itemPath + '/')) {
          if (gdriveSynced && googleToken && newMeta[path]) {
            deleteDriveFile(googleToken, newMeta[path]).catch(err => console.error(err));
          }
          delete newFiles[path];
          delete newMeta[path];
        }
      });
    }

    setFiles(newFiles);
    setDriveFilesMeta(newMeta);
    setSelectedItems([]);
    showToast(`Bulk delete complete`);
  }

  // Render Icon by File Type
  const renderItemIcon = (item) => {
    if (item.isDirectory) return <Folder size={18} color="#F59E0B" />;
    const name = item.name.toLowerCase();
    if (name.endsWith('.json')) return <FileJson size={18} color="#F59E0B" />;
    if (name.endsWith('.css') || name.endsWith('.scss')) return <FileCode2 size={18} color="#EC4899" />;
    if (name.endsWith('.jsx') || name.endsWith('.js') || name.endsWith('.ts') || name.endsWith('.tsx')) return <FileCode2 size={18} color="#6366F1" />;
    if (name.endsWith('.html')) return <Code2 size={18} color="#06B6D4" />;
    if (name.endsWith('.md') || name.endsWith('.txt')) return <FileText size={18} color="#94A3B8" />;
    return <FileCode2 size={18} color="#818CF8" />;
  }

  // Apply AI Actions (Edit/Delete/Move)
  const handleApplyAction = (action, msgId, status = 'applied') => {
    if (status === 'applied') {
      if (action.type === 'edit') {
        setFiles(prev => ({ ...prev, [action.file]: action.content }))
        if (activeFile === action.file) {
          setEditorContent(action.content)
        }
        showToast(`Applied changes to ${action.file}!`)
      } else if (action.type === 'delete') {
        setFiles(prev => {
          const newFiles = { ...prev };
          delete newFiles[action.file];
          return newFiles;
        })
        if (activeFile === action.file) {
          setEditorContent('')
        }
        showToast(`Deleted ${action.file}!`)
      } else if (action.type === 'move') {
        setFiles(prev => {
          const newFiles = { ...prev };
          if (newFiles[action.source] !== undefined) {
            newFiles[action.destination] = newFiles[action.source];
            delete newFiles[action.source];
          }
          return newFiles;
        })
        if (activeFile === action.source) {
          setActiveFile(action.destination)
        }
        showToast(`Moved ${action.source} to ${action.destination}!`)
      }
    } else {
      showToast(`Rejected changes for ${action.file || action.source}!`);
    }

    // Update message state to show action as resolved
    setChatMessages(prev => prev.map(msg => {
      if (msg.id === msgId && msg.actions) {
        return {
          ...msg,
          actions: msg.actions.map(a => a.id === action.id ? { ...a, status } : a)
        }
      }
      return msg;
    }))
  }

  const handleApplyAllActions = (msgId, actions, status = 'applied') => {
    setFiles(prev => {
      const newFiles = { ...prev };
      actions.forEach(action => {
        if (status === 'applied') {
          if (action.type === 'edit') {
            newFiles[action.file] = action.content;
          } else if (action.type === 'delete') {
            delete newFiles[action.file];
          } else if (action.type === 'move') {
            if (newFiles[action.source] !== undefined) {
              newFiles[action.destination] = newFiles[action.source];
              delete newFiles[action.source];
            }
          }
        }
      });
      return newFiles;
    });

    if (status === 'applied') {
      let activeChanged = false;
      actions.forEach(action => {
        if (action.type === 'edit' && activeFile === action.file) {
          setEditorContent(action.content);
        } else if (action.type === 'delete' && activeFile === action.file) {
          setEditorContent('');
        } else if (action.type === 'move' && activeFile === action.source) {
          setActiveFile(action.destination);
          activeChanged = true;
        }
      });
      showToast(`Applied ${actions.length} changes!`);
    } else {
      showToast(`Rejected ${actions.length} changes.`);
    }

    setChatMessages(prev => prev.map(msg => {
      if (msg.id === msgId && msg.actions) {
        return {
          ...msg,
          actions: msg.actions.map(a => actions.find(ac => ac.id === a.id) ? { ...a, status } : a)
        };
      }
      return msg;
    }));
  };

  // Send AI Prompt
  const handleSendPrompt = async (promptText = inputPrompt) => {
    if (!promptText.trim()) return

    const userMsg = {
      id: Date.now(),
      sender: 'user',
      text: promptText
    }

    setChatMessages(prev => [...prev, userMsg])
    if (promptText === inputPrompt) setInputPrompt('')
    setIsThinking(true)

    try {
      if (!apiKey || apiKey.trim() === '') {
        throw new Error("Please configure your Gemini API Key in the Settings tab.");
      }

      const { GoogleGenerativeAI } = await import("@google/generative-ai");
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: selectedModel });

      let contextStr = "Here is the current state of the workspace files:\n\n";
      for (const [path, content] of Object.entries(files)) {
        if (!path.endsWith('/') && !content.startsWith('// Folder:')) {
          contextStr += `--- FILE: ${path} ---\n${content}\n\n`;
        }
      }
      if (activeFile) {
        contextStr += `\nThe user is currently looking at the file: ${activeFile}\n\n`;
      }

      const systemPrompt = `You are an expert AI coding assistant integrated into an IDE. 
You have full read access to the user's workspace.
${contextStr}
Before answering, write out your step-by-step reasoning process inside <think>...</think> tags. 
To suggest code edits or create files, output EXACTLY this format:
<edit file="path/to/file.js">
// complete new file contents here
</edit>

To delete a file, output EXACTLY:
<delete file="path/to/file.js" />

To move or rename a file, output EXACTLY:
<move source="old/path.js" destination="new/path.js" />

You can output multiple <edit>, <delete>, and <move> blocks to modify multiple files at once. Avoid regular markdown code blocks if you intend for the user to apply the code.`;

      const result = await model.generateContent([
        { text: systemPrompt },
        { text: promptText }
      ]);

      let responseText = result.response.text();

      let thoughtProcess = null;
      const thinkMatch = responseText.match(/<think>([\s\S]*?)<\/think>/i);
      if (thinkMatch) {
        thoughtProcess = thinkMatch[1].trim();
        responseText = responseText.replace(/<think>([\s\S]*?)<\/think>/i, '').trim();
      }

      const actions = [];
      const editRegex = /<edit file="([^"]+)">([\s\S]*?)<\/edit>/gi;
      const deleteRegex = /<delete file="([^"]+)"\s*\/>/gi;
      const moveRegex = /<move source="([^"]+)" destination="([^"]+)"\s*\/>/gi;

      let match;
      while ((match = editRegex.exec(responseText)) !== null) {
        actions.push({ id: Math.random().toString(), type: 'edit', file: match[1], content: match[2].trim() });
      }
      while ((match = deleteRegex.exec(responseText)) !== null) {
        actions.push({ id: Math.random().toString(), type: 'delete', file: match[1] });
      }
      while ((match = moveRegex.exec(responseText)) !== null) {
        actions.push({ id: Math.random().toString(), type: 'move', source: match[1], destination: match[2] });
      }

      let cleanText = responseText.replace(editRegex, '').replace(deleteRegex, '').replace(moveRegex, '').trim();

      // Fallback for single markdown block if no tags are used
      if (actions.length === 0) {
        const codeMatch = cleanText.match(/```[a-z]*\n([\s\S]*?)```/i);
        if (codeMatch && codeMatch[1]) {
          actions.push({ id: Math.random().toString(), type: 'edit', file: activeFile || 'NewFile.js', content: codeMatch[1].trim() });
          cleanText = cleanText.replace(/```[a-z]*\n([\s\S]*?)```/gi, '');
        }
      }

      const assistantMsg = {
        id: Date.now() + 1,
        sender: 'assistant',
        text: cleanText,
        thought: thoughtProcess,
        actions: actions
      }

      setChatMessages(prev => [...prev, assistantMsg])
    } catch (err) {
      const errorMsg = {
        id: Date.now() + 1,
        sender: 'assistant',
        text: `**Error:** ${err.message}`
      }
      setChatMessages(prev => [...prev, errorMsg])
    } finally {
      setIsThinking(false)
    }
  }

  // Utility for Editor lines
  const lineCount = (editorContent || '').split('\n').length
  const lineNumbersArray = Array.from({ length: lineCount }, (_, i) => i + 1)

  return (
    <div className="app-container">
      {/* Toast Notification Popup */}
      {toastMessage && (
        <div className="toast-container">
          <div className="toast">{toastMessage}</div>
        </div>
      )}

      {/* Backdrop for open Chat Drawer */}
      {isChatOpen && (
        <div className="chat-backdrop" onClick={() => setIsChatOpen(false)} />
      )}

      {/* Main Header */}
      <header className="header" style={{ position: 'relative' }}>
        <div className="header-left">
          <div className="brand-badge" onClick={() => setIsLauncherOpen(true)} style={{ cursor: 'pointer' }} title="Switch Project">
            <Zap size={16} className="text-gradient" />
            <span className="header-title text-gradient">{currentProject || 'Quanta'}</span>
          </div>
          <div className="sync-status">
            <span className="sync-dot"></span>
            <span>{gdriveSynced ? 'Drive Synced' : 'Offline'}</span>
          </div>
        </div>

        <div className="header-actions">
          <button className={`icon-btn ${isSyncing ? 'disabled' : ''}`} onClick={handlePullAll} title="Pull from Drive" disabled={isSyncing}>
            <CloudDownload size={18} color="#3B82F6" />
          </button>
          <button className={`icon-btn ${isSyncing ? 'disabled' : ''}`} onClick={handlePushAll} title="Push to Drive" disabled={isSyncing}>
            <CloudUpload size={18} color="#10B981" />
          </button>
        </div>

        {/* Sync Progress Bar */}
        {(isSyncing || syncProgress > 0) && (
          <div style={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: '3px', background: 'rgba(255,255,255,0.1)' }}>
            <div style={{ height: '100%', background: 'var(--accent-primary)', width: `${syncProgress}%`, transition: 'width 0.2s ease-out' }} />
          </div>
        )}
      </header>

      {/* Open Files Tab Bar (visible when code editor or files tab active) */}
      {openTabs.length > 0 && (
        <div className="open-tabs-bar">
          {openTabs.map(tab => (
            <div
              key={tab}
              className={`tab-item ${activeFile === tab && activeTab === 'code' ? 'active' : ''}`}
              onClick={() => handleOpenFile(tab)}
            >
              <span>{tab}</span>
              <span className="tab-close" onClick={(e) => handleCloseTab(e, tab)}>
                <X size={12} />
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Main Views Body */}
      <main className="main-content">

        {/* 1. PTERODACTYL & IDE FILE EXPLORER VIEW */}
        {activeTab === 'files' && (
          <div className="file-explorer" style={{ gap: '14px' }}>

            {/* Breadcrumb Navigation Bar */}
            <div className="breadcrumb-bar">
              <div
                className={`breadcrumb-item ${currentFolderPath.length === 0 ? 'active' : ''}`}
                onClick={() => {
                  setCurrentFolderPath([]);
                  setSelectedItems([]);
                }}
              >
                <Home size={16} color="#6366F1" />
                <span>{currentProject || 'root'}</span>
              </div>

              {currentFolderPath.map((folder, idx) => (
                <div key={folder} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <ChevronRight className="breadcrumb-separator" size={14} />
                  <div
                    className={`breadcrumb-item ${idx === currentFolderPath.length - 1 ? 'active' : ''}`}
                    onClick={() => {
                      setCurrentFolderPath(currentFolderPath.slice(0, idx + 1));
                      setSelectedItems([]);
                    }}
                  >
                    <Folder size={14} color="#F59E0B" />
                    <span>{folder}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Toolbar Action Bar */}
            <div className="file-manager-toolbar">
              <div className="toolbar-actions-left">
                {currentFolderPath.length > 0 && (
                  <button
                    className="toolbar-btn"
                    onClick={() => {
                      setCurrentFolderPath(prev => prev.slice(0, -1));
                      setSelectedItems([]);
                    }}
                  >
                    <ArrowLeft size={16} />
                    <span>Back</span>
                  </button>
                )}

                <button
                  className="toolbar-btn primary"
                  onClick={() => {
                    setCreateModalType('file');
                    setCreateItemName('');
                  }}
                >
                  <FilePlus size={16} />
                  <span>New File</span>
                </button>

                <button
                  className="toolbar-btn"
                  onClick={() => {
                    setCreateModalType('folder');
                    setCreateItemName('');
                  }}
                >
                  <FolderPlus size={16} color="#F59E0B" />
                  <span>New Folder</span>
                </button>
              </div>

              <div className="toolbar-actions-right">
                <div className="search-input-box" style={{ width: '180px', padding: '6px 10px' }}>
                  <Search size={14} color="#94A3B8" />
                  <input
                    type="text"
                    placeholder="Filter..."
                    value={folderSearchQuery}
                    onChange={(e) => setFolderSearchQuery(e.target.value)}
                    style={{ fontSize: '0.8rem' }}
                  />
                  {folderSearchQuery && (
                    <X size={14} color="#94A3B8" style={{ cursor: 'pointer' }} onClick={() => setFolderSearchQuery('')} />
                  )}
                </div>

                <button
                  className="icon-btn"
                  onClick={() => {
                    if (gdriveSynced && googleToken) fetchWorkspaceFromDrive(googleToken);
                    else showToast('Refreshed local directory');
                  }}
                  title="Refresh"
                >
                  <RefreshCw size={16} />
                </button>
              </div>
            </div>

            {/* Pterodactyl IDE Table View */}
            <div className="pterodactyl-table-container">
              <table className="pterodactyl-table">
                <thead>
                  <tr>
                    <th style={{ width: '40px' }}>
                      <div
                        className={`custom-checkbox ${getCurrentDirectoryContents().length > 0 && selectedItems.length === getCurrentDirectoryContents().length ? 'checked' : ''}`}
                        onClick={() => {
                          const all = getCurrentDirectoryContents().map(i => i.fullPath);
                          if (selectedItems.length === all.length) setSelectedItems([]);
                          else setSelectedItems(all);
                        }}
                      >
                        {selectedItems.length > 0 && <Check size={12} color="white" />}
                      </div>
                    </th>
                    <th>Name</th>
                    <th>Size / Lines</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {getCurrentDirectoryContents().length === 0 ? (
                    <tr>
                      <td colSpan="5" style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)' }}>
                        Folder is empty
                      </td>
                    </tr>
                  ) : (
                    getCurrentDirectoryContents().map((item) => {
                      const isChecked = selectedItems.includes(item.fullPath);
                      return (
                        <tr key={`${item.isDirectory ? 'folder' : 'file'}-${item.fullPath}`} className={isChecked ? 'selected' : ''}>
                          <td>
                            <div
                              className={`custom-checkbox ${isChecked ? 'checked' : ''}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (isChecked) {
                                  setSelectedItems(prev => prev.filter(i => i !== item.fullPath));
                                } else {
                                  setSelectedItems(prev => [...prev, item.fullPath]);
                                }
                              }}
                            >
                              {isChecked && <Check size={12} color="white" />}
                            </div>
                          </td>
                          <td>
                            <div
                              className="file-name-cell"
                              onClick={() => {
                                if (item.isDirectory) {
                                  setCurrentFolderPath(prev => [...prev, item.name]);
                                  setSelectedItems([]);
                                } else {
                                  handleOpenFile(item.fullPath);
                                }
                              }}
                            >
                              {renderItemIcon(item)}
                              <span className="file-name-text">{item.name}</span>
                            </div>
                          </td>
                          <td style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                            {item.lineCount}
                          </td>
                          <td>
                            <span style={{ fontSize: '0.75rem', color: 'var(--success)', background: 'var(--success-glow)', padding: '2px 8px', borderRadius: '8px' }}>
                              {item.modified}
                            </span>
                          </td>
                          <td>
                            <div className="row-actions">
                              <button
                                className="action-icon-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setItemToRename({ item, newName: item.name });
                                }}
                                title="Rename"
                              >
                                <Edit3 size={15} />
                              </button>
                              <button
                                className="action-icon-btn danger"
                                onClick={(e) => requestDeleteFile(e, item.fullPath)}
                                title="Delete"
                              >
                                <Trash2 size={15} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>

          </div>
        )}

        {/* 2. CODE EDITOR VIEW */}
        {activeTab === 'code' && (
          !activeFile ? (
            <div className="empty-editor-view">
              <Code2 size={48} style={{ opacity: 0.4, marginBottom: '10px' }} />
              <p>No open files in editor</p>
              <button className="primary-btn" onClick={() => setActiveTab('files')}>
                Go to Workspace
              </button>
            </div>
          ) : (
            <div className="editor-container">
              <div className="editor-wrapper">
                <div className="line-numbers" ref={lineNumbersRef}>
                  {lineNumbersArray.map(n => {
                    const isError = syntaxError && syntaxError.line === n;
                    return (
                      <div
                        key={n}
                        style={isError ? { backgroundColor: 'rgba(239, 68, 68, 0.2)', color: '#EF4444', borderRadius: '4px', position: 'relative', fontWeight: 'bold' } : {}}
                        title={isError ? syntaxError.message : undefined}
                      >
                        {n}
                      </div>
                    )
                  })}
                </div>
                <Editor
                  className="code-textarea"
                  value={editorContent}
                  onValueChange={code => setEditorContent(code)}
                  highlight={code => {
                    try {
                      const ext = activeFile ? activeFile.split('.').pop() : 'js';
                      let lang = Prism.languages.javascript || Prism.languages.extend('clike', {});
                      let langName = 'javascript';
                      if (ext === 'css') { lang = Prism.languages.css || lang; langName = 'css'; }
                      else if (ext === 'html') { lang = Prism.languages.markup || lang; langName = 'markup'; }

                      if (!lang) return code;
                      return Prism.highlight(code || '', lang, langName);
                    } catch (err) {
                      console.error("Prism highlight error:", err);
                      return code;
                    }
                  }}
                  padding={16}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.85rem',
                    lineHeight: '1.6',
                    width: '100%',
                    backgroundColor: 'transparent',
                  }}
                  textareaClassName="code-textarea-internal"
                  spellCheck="false"
                />
              </div>
              <div className="editor-status-bar">
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {activeFile}
                  {syntaxError && (
                    <span style={{ color: '#EF4444', background: 'rgba(239,68,68,0.1)', padding: '2px 6px', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <X size={12} /> Line {syntaxError.line}: {syntaxError.message}
                    </span>
                  )}
                </span>
                <span>UTF-8 • {lineCount} Lines</span>
                <span>{selectedModel}</span>
              </div>
            </div>
          )
        )}

        {/* 3. GLOBAL SEARCH VIEW */}
        {activeTab === 'search' && (
          <div className="search-view">
            <div className="search-input-box">
              <Search size={18} color="#94A3B8" />
              <input
                type="text"
                placeholder="Search across files & cloud code..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <X size={16} color="#94A3B8" style={{ cursor: 'pointer' }} onClick={() => setSearchQuery('')} />
              )}
            </div>

            <div className="search-results">
              {searchQuery.trim() === '' ? (
                <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  Type a keyword to search workspace...
                </div>
              ) : (
                Object.keys(files).flatMap(fileName => {
                  const lines = files[fileName].split('\n')
                  return lines
                    .map((line, idx) => ({ line, lineNo: idx + 1 }))
                    .filter(item => item.line.toLowerCase().includes(searchQuery.toLowerCase()))
                    .map(match => (
                      <div
                        key={`${fileName}-${match.lineNo}`}
                        className="search-match-card"
                        onClick={() => {
                          handleOpenFile(fileName)
                        }}
                      >
                        <div className="search-match-header">
                          <span>{fileName}</span>
                          <span>Line {match.lineNo}</span>
                        </div>
                        <div className="search-match-snippet">
                          {match.line.trim()}
                        </div>
                      </div>
                    ))
                })
              )}
            </div>
          </div>
        )}

        {/* 4. SETTINGS VIEW */}
        {activeTab === 'settings' && (
          <div className="settings-view">
            <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>Preferences & Cloud</h3>

            <div className="settings-card">
              <div className="settings-item">
                <div className="setting-info">
                  <div className="setting-title">Google Drive Auto-Sync</div>
                  <div className="setting-desc">Sync code modifications seamlessly</div>
                </div>
                <div
                  className={`toggle-switch ${gdriveSynced ? 'on' : ''}`}
                  onClick={() => {
                    if (!gdriveSynced) {
                      loginWithGoogle();
                    } else {
                      setGdriveSynced(false);
                      setGoogleToken(null);
                      showToast('Sync Disabled (Offline)');
                    }
                  }}
                >
                  <div className="toggle-circle"></div>
                </div>
              </div>

              <div style={{ marginTop: '15px', paddingTop: '15px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <div className="setting-title" style={{ marginBottom: '6px' }}>Google OAuth Client ID</div>
                <div className="setting-desc" style={{ marginBottom: '10px' }}>
                  Get this from <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer" style={{ color: '#818CF8' }}>Google Cloud Console</a>. (Requires page reload to apply changes)
                </div>
                <input
                  type="text"
                  className="settings-input"
                  defaultValue={localStorage.getItem('googleClientId') || ''}
                  onChange={(e) => {
                    localStorage.setItem('googleClientId', e.target.value.trim());
                  }}
                  placeholder="Enter your Client ID here..."
                />
              </div>
            </div>

            <div className="settings-card">
              <div className="setting-title">AI Engine Model</div>
              <select
                className="settings-select"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
              >
                <option value="gemma-4-31b-it">Gemma 4 31B</option>
                <option value="gemma-4-26b-a4b-it">Gemma 4 26B</option>
                <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite</option>
                <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                <option value="gemini-3-flash">Gemini 3 Flash</option>
                <option value="gemini-3.1-pro">Gemini 3.1 Pro</option>
                <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite</option>
                <option value="gemini-3.5-flash">Gemini 3.5 Flash</option>
                <option value="gemini-3.5-flash-lite">Gemini 3.5 Flash Lite</option>
                <option value="gemini-3.6-flash">Gemini 3.6 Flash</option>
                <option value="gemini-2.0-flash">Gemini 2 Flash</option>
                <option value="gemini-2.0-flash-lite-preview-02-05">Gemini 2 Flash Lite</option>
                <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
                <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
              </select>

              <div style={{ marginTop: '10px' }}>
                <div className="setting-title" style={{ marginBottom: '6px' }}>Gemini API Key</div>
                <input
                  type="password"
                  className="settings-input"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </div>
            </div>
          </div>
        )}

      </main>

      {/* Floating Action Sparkle Button for AI Drawer */}
      <div className="fab-container">
        <button
          className="fab-button"
          onClick={() => setIsChatOpen(!isChatOpen)}
        >
          {isChatOpen ? <X size={24} /> : <Sparkles size={24} />}
        </button>
      </div>

      {/* Slide-Up AI Chat Drawer */}
      <div className={`chat-drawer ${isChatOpen ? 'open' : ''}`}>
        <div className="drawer-handle"></div>

        <div className="drawer-header">
          <div className="drawer-title-box">
            <Sparkles size={18} color="#818CF8" />
            <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>Antigravity AI</span>
          </div>
          <span className="model-badge">{selectedModel}</span>
        </div>

        {/* Quick Action Prompt Pills */}
        <div className="prompt-pills">
          <div className="prompt-pill" onClick={() => handleSendPrompt("Explain this file logic")}>
            💡 Explain File
          </div>
          <div className="prompt-pill" onClick={() => handleSendPrompt("Fix potential syntax bugs")}>
            🐛 Fix Bugs
          </div>
          <div className="prompt-pill" onClick={() => handleSendPrompt("Add error handling and optimization")}>
            ⚡ Optimize Code
          </div>
        </div>

        {/* Messages Scroll Area */}
        <div className="chat-messages">
          {chatMessages.map(msg => (
            <div key={msg.id} className={`message-bubble ${msg.sender}`}>
              {msg.thought && (
                <details className="think-box" style={{ marginBottom: '8px', fontSize: '0.85rem', color: '#818CF8', border: '1px solid #374151', borderRadius: '8px', padding: '6px' }}>
                  <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 500 }}><Brain size={14} /> View AI Reasoning Process</summary>
                  <div style={{ marginTop: '8px', color: '#9CA3AF', whiteSpace: 'pre-wrap' }}>{msg.thought}</div>
                </details>
              )}
              {msg.text && (
                <div className="markdown-body" style={{ color: 'var(--text-primary)', fontSize: '0.95rem', lineHeight: '1.5' }}>
                  <ReactMarkdown
                    components={{
                      code({ node, inline, className, children, ...props }) {
                        const match = /language-(\w+)/.exec(className || '')
                        return !inline && match ? (
                          <SyntaxHighlighter
                            style={vscDarkPlus}
                            language={match[1]}
                            PreTag="div"
                            customStyle={{ borderRadius: '8px', padding: '12px' }}
                            {...props}
                          >
                            {String(children).replace(/\n$/, '')}
                          </SyntaxHighlighter>
                        ) : (
                          <code className={className} style={{ background: 'rgba(255,255,255,0.1)', padding: '2px 4px', borderRadius: '4px' }} {...props}>
                            {children}
                          </code>
                        )
                      }
                    }}
                  >
                    {msg.text}
                  </ReactMarkdown>
                </div>
              )}
              {msg.actions && (() => {
                const pendingActions = msg.actions.filter(a => !a.status);
                if (pendingActions.length === 0) return null;
                return (
                  <>
                    {pendingActions.map(action => (
                      <div key={action.id} className="code-preview-block" style={{ paddingBottom: '8px' }}>
                        <div className="code-preview-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <span style={{ color: action.type === 'delete' ? '#EF4444' : action.type === 'move' ? '#F59E0B' : '#A7F3D0', fontWeight: 600 }}>
                              {action.type === 'edit' && `Edit / Create: ${action.file}`}
                              {action.type === 'delete' && `Delete: ${action.file}`}
                              {action.type === 'move' && `Move/Rename: ${action.source} ➔ ${action.destination}`}
                            </span>
                            {action.type === 'edit' && (
                              <span style={{ fontSize: '0.75rem', color: '#9CA3AF' }}>
                                +{action.content.split('\n').length} lines of code
                              </span>
                            )}
                          </div>
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <button
                              className="apply-code-btn"
                              onClick={() => handleApplyAction(action, msg.id, 'rejected')}
                              style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#EF4444', border: '1px solid rgba(239, 68, 68, 0.2)' }}
                            >
                              <X size={14} /> Reject
                            </button>
                            <button
                              className="apply-code-btn"
                              onClick={() => handleApplyAction(action, msg.id, 'applied')}
                              style={{ background: action.type === 'delete' ? 'rgba(239, 68, 68, 0.2)' : action.type === 'move' ? 'rgba(245, 158, 11, 0.2)' : 'rgba(16, 185, 129, 0.2)' }}
                            >
                              <Check size={14} /> Accept
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                    {pendingActions.length > 1 && (
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '8px 0', borderTop: '1px solid rgba(255,255,255,0.05)', marginTop: '4px' }}>
                        <button
                          className="apply-code-btn"
                          onClick={() => handleApplyAllActions(msg.id, pendingActions, 'rejected')}
                          style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#EF4444', border: '1px solid rgba(239, 68, 68, 0.2)' }}
                        >
                          <X size={14} /> Reject All
                        </button>
                        <button
                          className="apply-code-btn"
                          onClick={() => handleApplyAllActions(msg.id, pendingActions, 'applied')}
                          style={{ background: 'rgba(16, 185, 129, 0.2)', color: '#A7F3D0' }}
                        >
                          <Check size={14} /> Accept All ({pendingActions.length})
                        </button>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          ))}

          {isThinking && (
            <div className="message-bubble assistant" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <RefreshCw size={16} className="animate-spin-slow" color="#818CF8" />
              <span>Thinking...</span>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Chat Input Bar */}
        <div className="chat-input-container">
          <input
            type="text"
            className="chat-input"
            placeholder="Ask AI to modify code or design logic..."
            value={inputPrompt}
            onChange={(e) => setInputPrompt(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSendPrompt()}
          />
          <button className="send-btn" onClick={() => handleSendPrompt()}>
            <Send size={18} />
          </button>
        </div>
      </div>

      {/* Custom Creation Modal (File / Folder) */}
      {createModalType && (
        <div className="modal-backdrop" onClick={() => setCreateModalType(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                {createModalType === 'file' ? (
                  <>
                    <FileCode2 size={20} color="#6366F1" />
                    <span>Create New File</span>
                  </>
                ) : (
                  <>
                    <Folder size={20} color="#F59E0B" />
                    <span>Create New Folder</span>
                  </>
                )}
              </div>
              <X size={18} style={{ cursor: 'pointer' }} onClick={() => setCreateModalType(null)} />
            </div>

            <form onSubmit={handleCreateSubmit}>
              <input
                type="text"
                className="modal-input"
                placeholder={createModalType === 'file' ? 'e.g. Component.jsx' : 'e.g. components'}
                value={createItemName}
                onChange={(e) => setCreateItemName(e.target.value)}
                autoFocus
              />

              <div className="modal-actions" style={{ marginTop: '16px' }}>
                <button type="button" className="btn-secondary" onClick={() => setCreateModalType(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Custom Confirm Delete Modal */}
      {itemToDelete && (
        <div className="modal-backdrop" onClick={() => setItemToDelete(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title" style={{ color: '#EF4444' }}>
                <Trash2 size={20} color="#EF4444" />
                <span>Delete Confirmation</span>
              </div>
              <X size={18} style={{ cursor: 'pointer' }} onClick={() => setItemToDelete(null)} />
            </div>

            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', margin: 0 }}>
              Are you sure you want to delete <strong style={{ color: 'var(--text-primary)' }}>{itemToDelete}</strong>? This action cannot be undone.
            </p>

            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setItemToDelete(null)}>
                Cancel
              </button>
              <button className="btn-danger" onClick={handleConfirmDelete}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Project Launcher Modal / Welcome Screen */}
      {isLauncherOpen && (
        <div className="project-launcher">
          <div className="launcher-card">
            <div className="launcher-header">
              <div className="brand-badge" style={{ padding: '8px 16px', borderRadius: '16px' }}>
                <Zap size={22} className="text-gradient" />
                <span className="header-title text-gradient" style={{ fontSize: '1.3rem' }}>Quanta IDE</span>
              </div>
              <div className="launcher-title">Welcome to Mobile IDE</div>
              <div className="launcher-subtitle">Select a project to start coding or create a new one</div>
            </div>

            {/* Create New Project Section */}
            <div className="launcher-section">
              <div className="launcher-section-title">✨ Create New Project</div>
              <form
                className="project-input-group"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSelectProject(newProjectInput);
                  setNewProjectInput('');
                }}
              >
                <input
                  type="text"
                  className="modal-input"
                  placeholder="e.g. My-Awesome-App"
                  value={newProjectInput}
                  onChange={(e) => setNewProjectInput(e.target.value)}
                />
                <button type="submit" className="btn-primary" style={{ whiteSpace: 'nowrap' }}>
                  Create
                </button>
              </form>
            </div>

            {/* Open Existing Project Section */}
            <div className="launcher-section">
              <div className="launcher-section-title">📂 Open Existing Project</div>
              <div className="project-list">
                {recentProjects.map(proj => (
                  <div
                    key={proj}
                    className="project-item"
                    onClick={() => handleSelectProject(proj)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <Folder size={18} color="#6366F1" />
                      <span style={{ fontWeight: 500, fontSize: '0.9rem' }}>{proj}</span>
                    </div>
                    {currentProject === proj && (
                      <span style={{ fontSize: '0.75rem', background: 'var(--accent-glow)', color: 'var(--accent-primary)', padding: '2px 8px', borderRadius: '8px' }}>
                        Active
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {currentProject && (
              <button className="btn-secondary" onClick={() => setIsLauncherOpen(false)}>
                Continue with {currentProject}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Custom Rename Modal */}
      {itemToRename && (
        <div className="modal-backdrop" onClick={() => setItemToRename(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                <Edit3 size={20} color="#6366F1" />
                <span>Rename {itemToRename.item.isDirectory ? 'Folder' : 'File'}</span>
              </div>
              <X size={18} style={{ cursor: 'pointer' }} onClick={() => setItemToRename(null)} />
            </div>

            <form onSubmit={handleRenameSubmit}>
              <input
                type="text"
                className="modal-input"
                value={itemToRename.newName}
                onChange={(e) => setItemToRename({ ...itemToRename, newName: e.target.value })}
                autoFocus
              />

              <div className="modal-actions" style={{ marginTop: '16px' }}>
                <button type="button" className="btn-secondary" onClick={() => setItemToRename(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  Rename
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Pterodactyl Bulk Actions Toolbar */}
      {selectedItems.length > 0 && (
        <div className="bulk-action-bar">
          <div className="bulk-info">
            {selectedItems.length} {selectedItems.length === 1 ? 'item' : 'items'} selected
          </div>
          <button className="btn-danger" onClick={() => setIsBulkDeleteModalOpen(true)}>
            <Trash2 size={15} /> Delete Selected
          </button>
          <button className="btn-secondary" onClick={() => setSelectedItems([])}>
            Deselect All
          </button>
        </div>
      )}

      {/* Bulk Delete Confirm Modal */}
      {isBulkDeleteModalOpen && (
        <div className="modal-backdrop" onClick={() => setIsBulkDeleteModalOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title" style={{ color: '#EF4444' }}>
                <Trash2 size={20} color="#EF4444" />
                <span>Bulk Delete Confirmation</span>
              </div>
              <X size={18} style={{ cursor: 'pointer' }} onClick={() => setIsBulkDeleteModalOpen(false)} />
            </div>

            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', margin: 0 }}>
              Are you sure you want to delete <strong style={{ color: 'var(--text-primary)' }}>{selectedItems.length} items</strong>? This action cannot be undone.
            </p>

            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setIsBulkDeleteModalOpen(false)}>
                Cancel
              </button>
              <button className="btn-danger" onClick={handleBulkDelete}>
                Delete All
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom Navigation Toolbar */}
      <nav className="bottom-nav">
        <div
          className={`nav-item ${activeTab === 'files' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('files')
            setIsChatOpen(false)
          }}
        >
          <Folder className="nav-icon" size={22} />
          <span>Workspace</span>
        </div>
        <div
          className={`nav-item ${activeTab === 'code' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('code')
            setIsChatOpen(false)
          }}
        >
          <Code2 className="nav-icon" size={22} />
          <span>Editor</span>
        </div>
        <div
          className={`nav-item ${activeTab === 'search' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('search')
            setIsChatOpen(false)
          }}
        >
          <Search className="nav-icon" size={22} />
          <span>Search</span>
        </div>
        <div
          className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('settings')
            setIsChatOpen(false)
          }}
        >
          <Settings className="nav-icon" size={22} />
          <span>Settings</span>
        </div>
      </nav>
    </div>
  )
}

export default App
