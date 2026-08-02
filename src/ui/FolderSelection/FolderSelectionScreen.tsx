import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Folder, ArrowLeft, HardDrive, Check, Search, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { db } from '../../db/db';
import { getValidToken } from '../../utils/apiClient';
import { getFileParents, getFileName } from '../../utils/driveApi';
import { searchFolders, listFolderChildren } from '../../utils/drivePagination';
import { showErrorToast } from '../../utils/simpleToast';
import { captureError } from '../../utils/errorLog';

const FOLDER_MODULE = "FolderSelection";
const SEARCH_DEBOUNCE_MS = 300;
const DRIVE_ROOT_ID = 'root';
const LS_ROOT_FOLDER = 'drplay_root_folder';
const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

// Classify a Drive fetch error for observability. Returns name + message only.
function classifyFolderError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  return `${name}: ${message}`;
}

// fetch aborts (AbortController/AbortSignal) reject with a DOMException named
// 'AbortError' — the caller requested the cancellation, so it must not be
// surfaced as a user-facing error. Check both shapes: browsers' DOMException
// extends Error, but jsdom's implementation does not.
function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  return typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError';
}

interface FolderItem {
  id: string;
  name: string;
}

function FolderCard({ folder, onClick }: { folder: FolderItem; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      onClick={onClick}
      className="p-4 rounded-xl bg-[#F8F9FA] dark:bg-[#202124] hover:bg-gray-100 dark:hover:bg-[#2a2b2f] hover:shadow-md hover:-translate-y-1 transition-all duration-300 cursor-pointer group flex items-center gap-4"
    >
      <div className="w-12 h-12 rounded-lg flex items-center justify-center shrink-0 overflow-hidden transition-colors bg-amber-100 dark:bg-amber-900/30 text-amber-500">
        <Folder className="w-6 h-6" fill="currentColor" />
      </div>
      <div className="overflow-hidden flex-1">
        <h3 className="font-semibold text-gray-800 dark:text-gray-200 group-hover:text-[#4285F4] transition-colors truncate">
          {folder.name}
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
          {t('drive.folders')}
        </p>
      </div>
    </div>
  );
}

interface FolderSelectionScreenProps {
  token: string;
  onSelectFolder: (folderId: string) => void;
  onCancel?: () => void; // Optional cancel for when called from Settings
  initialFolderId?: string;
  initialFolderName?: string;
  initialFolderHistory?: {id: string, name: string}[];
  title?: string;
  subtitle?: string;
  appRootFolder?: string | null;
  allowEscapeRoot?: boolean;
}

export function FolderSelectionScreen({ token, onSelectFolder, onCancel, initialFolderId = DRIVE_ROOT_ID, initialFolderName, initialFolderHistory = [], title, subtitle, appRootFolder, allowEscapeRoot = false }: FolderSelectionScreenProps) {
  const { t } = useTranslation();
  
  // Resolve appRootFolder from props or localStorage
  const resolvedAppRoot = appRootFolder || localStorage.getItem(LS_ROOT_FOLDER);
  
  const [currentFolderId, setCurrentFolderId] = useState(initialFolderId === DRIVE_ROOT_ID && resolvedAppRoot ? resolvedAppRoot : initialFolderId);
  const [currentFolderName, setCurrentFolderName] = useState(initialFolderName || t('drive.my_drive'));
  const [folderHistory, setFolderHistory] = useState<{id: string, name: string}[]>(initialFolderHistory);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [apiSearchResults, setApiSearchResults] = useState<FolderItem[]>([]);
  const [isSearchingApi, setIsSearchingApi] = useState(false);
  const isLoadingRef = useRef(false);
  const apiSearchAbortRef = useRef<AbortController | null>(null);
  const foldersAbortRef = useRef<AbortController | null>(null);

  const filteredFolders = useMemo(() => {
    if (!searchQuery.trim()) return folders;
    const q = searchQuery.toLowerCase().trim();
    return folders.filter(f => f.name.toLowerCase().includes(q));
  }, [folders, searchQuery]);

  const searchSubfolders = useCallback(async (query: string) => {
    apiSearchAbortRef.current?.abort();
    if (query.trim().length < 2) { setApiSearchResults([]); return; }
    const controller = new AbortController();
    apiSearchAbortRef.current = controller;
    setIsSearchingApi(true);
    try {
      const safeQuery = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const q = `name contains '${safeQuery}' and mimeType='${DRIVE_FOLDER_MIME_TYPE}' and trashed=false`;
      const files = await searchFolders(token, q, controller.signal);
      setApiSearchResults(files.filter((f: FolderItem) => f.id !== currentFolderId));
    } catch (e: unknown) {
      if (!isAbortError(e)) {
        setApiSearchResults([]);
        captureError({ level: 'warn', source: FOLDER_MODULE, message: `api-search-failed: ${classifyFolderError(e)}` });
        showErrorToast(t('folder_selection.search_error') || 'Failed to search folders');
      }
    } finally {
      setIsSearchingApi(false);
    }
  }, [token, currentFolderId]);

  useEffect(() => {
    if (!searchQuery.trim() || filteredFolders.length > 0) {
      setApiSearchResults([]);
      setIsSearchingApi(false);
      return;
    }
    setIsSearchingApi(true);
    const timer = setTimeout(() => searchSubfolders(searchQuery.trim()), SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); apiSearchAbortRef.current?.abort(); };
  }, [searchQuery, filteredFolders.length, searchSubfolders]);

  useEffect(() => {
    fetchFolders(currentFolderId);
    setSearchQuery('');
    setApiSearchResults([]);
    return () => cancelFolderFetch();
  }, [currentFolderId, token]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        if (document.activeElement === searchInputRef.current) {
          searchInputRef.current?.blur();
          setSearchQuery("");
        } else {
          searchInputRef.current?.focus();
        }
      }
      if (e.key === 'Escape' && document.activeElement === searchInputRef.current) {
        searchInputRef.current?.blur();
        setSearchQuery("");
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const cancelFolderFetch = useCallback(() => {
    foldersAbortRef.current?.abort();
    foldersAbortRef.current = null;
  }, []);

  const fetchFolders = async (folderId: string) => {
    cancelFolderFetch();
    const controller = new AbortController();
    foldersAbortRef.current = controller;

    isLoadingRef.current = true;
    setIsLoading(true);
    setFolders([]);
    try {
      const dbFolders = await db.files.where('parentId').equals(folderId).filter(f => f.isFolder).toArray();
      if (controller.signal.aborted) return;
      if (dbFolders.length > 0) {
        setFolders(dbFolders.map(c => ({ id: c.id, name: c.name })));
      } else {
        const freshToken = (await getValidToken()) || token;
        if (controller.signal.aborted) return;
        const files = await listFolderChildren(freshToken, folderId, controller.signal);
        if (controller.signal.aborted) return;
        setFolders(files.map(f => ({ id: f.id, name: f.name })));
      }
    } catch (e) {
      if (isAbortError(e)) return;
      captureError({ level: 'error', source: FOLDER_MODULE, message: `failed-to-fetch-folders: ${classifyFolderError(e)}` });
      showErrorToast(t('folder_selection.folders_error') || 'Failed to load folders');
      setFolders([]);
    } finally {
      if (foldersAbortRef.current === controller) {
        isLoadingRef.current = false;
        setIsLoading(false);
      }
    }
  };

  const handleOpenFolder = (folderId: string, folderName: string) => {
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;
    setIsLoading(true);
    setFolderHistory(prev => [...prev, { id: currentFolderId, name: currentFolderName }]);
    setCurrentFolderId(folderId);
    setCurrentFolderName(folderName);
  };

  const handleBack = async () => {
    if (folderHistory.length > 0) {
      cancelFolderFetch();
      const newHistory = [...folderHistory];
      const prevFolder = newHistory.pop();
      setFolderHistory(newHistory);
      setCurrentFolderId(prevFolder?.id || resolvedAppRoot || DRIVE_ROOT_ID);
      setCurrentFolderName(prevFolder?.name || t('drive.my_drive'));
      return;
    }

    if (currentFolderId === DRIVE_ROOT_ID || (!allowEscapeRoot && resolvedAppRoot && currentFolderId === resolvedAppRoot)) return;

    cancelFolderFetch();
    isLoadingRef.current = true;
    setIsLoading(true);
    try {
      const parents = await getFileParents(token, currentFolderId);
      if (parents === null) {
        // Drive request failed hard — fall back to root.
        setCurrentFolderId(DRIVE_ROOT_ID);
        setCurrentFolderName(t('drive.my_drive'));
      } else if (parents.length > 0) {
        const fetchedParentId = parents[0];
        setCurrentFolderId(fetchedParentId);
        if (fetchedParentId === DRIVE_ROOT_ID) {
          setCurrentFolderName(t('drive.my_drive'));
        } else {
          try {
            const name = await getFileName(token, fetchedParentId);
            if (name) setCurrentFolderName(name);
          } catch (e) {
            captureError({ level: 'warn', source: FOLDER_MODULE, message: `fetch-parent-name-failed: ${classifyFolderError(e)}` });
          }
        }
      } else {
        setCurrentFolderId(DRIVE_ROOT_ID);
      }
    } catch (e) {
      captureError({ level: 'error', source: FOLDER_MODULE, message: `fetch-parent-failed: ${classifyFolderError(e)}` });
      showErrorToast(t('folder_selection.back_error') || 'Failed to navigate back');
      setCurrentFolderId(DRIVE_ROOT_ID);
      setCurrentFolderName(t('drive.my_drive'));
    }
  };

  const handleBreadcrumbClick = (index: number) => {
    if (index === -1) {
      setFolderHistory([]);
      setCurrentFolderId(resolvedAppRoot || DRIVE_ROOT_ID);
      setCurrentFolderName(initialFolderName || t('drive.my_drive'));
      return;
    }
    const target = folderHistory[index];
    setFolderHistory(prev => prev.slice(0, index));
    setCurrentFolderId(target.id);
    setCurrentFolderName(target.name);
  };

  return (
    <div 
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={() => { if (onCancel) onCancel(); }}
    >
      <div 
        className="bg-white dark:bg-[#121212] w-full max-w-3xl h-[75vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        
        {/* Header */}
        <div className="px-6 py-5 flex items-center justify-between shrink-0">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-3">
              <HardDrive className="text-[#4285F4] w-6 h-6" />
              {title || t('folder_selection.select_root')}
            </h1>
            <p className="text-xs text-gray-500 mt-1">
              {subtitle || t('folder_selection.select_music_folder')}
            </p>
          </div>
          {onCancel && (
            <button 
              onClick={onCancel}
              className="text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
            </button>
          )}
        </div>

        {/* Toolbar / Breadcrumb / Search */}
        <div className="px-6 py-3 flex items-center gap-2 shrink-0 bg-gray-50/50 dark:bg-[#1a1b1e]/50">
          <button 
            onClick={handleBack}
            disabled={folderHistory.length === 0 && (currentFolderId === DRIVE_ROOT_ID || (!allowEscapeRoot && currentFolderId === resolvedAppRoot))}
            className="p-1.5 rounded-full hover:bg-gray-200 dark:hover:bg-gray-800 disabled:opacity-30 transition-colors shrink-0"
          >
            <ArrowLeft className="w-4 h-4 text-gray-700 dark:text-gray-300" />
          </button>

          <div className="flex items-center text-sm font-medium overflow-x-auto whitespace-nowrap hide-scrollbar flex-1 min-w-0 mr-2">
            {folderHistory.map((item, index) => (
              <React.Fragment key={index}>
                <span 
                  onClick={() => handleBreadcrumbClick(index)}
                  className="cursor-pointer text-gray-500 dark:text-gray-400 hover:text-[#4285F4] transition-colors"
                >
                  {item.name}
                </span>
                <span className="mx-2 text-gray-400 dark:text-gray-600">/</span>
              </React.Fragment>
            ))}
            <span className="text-gray-900 dark:text-white truncate">
              {currentFolderName}
            </span>
          </div>

          <div className="relative shrink-0 w-56">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder={t('search_placeholder', 'Search...')}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm bg-gray-100 dark:bg-[#1c1d21] hover:bg-gray-200 dark:hover:bg-[#25262a] focus:bg-white dark:focus:bg-[#1c1d21] text-gray-900 dark:text-gray-100 rounded-xl border border-transparent focus:border-[#4285F4]/50 outline-none transition-all placeholder:text-gray-500"
            />
          </div>
        </div>

        {/* Folder List */}
        <div className="flex-1 overflow-y-auto p-6 bg-white dark:bg-[#121212]">
          {isLoading && !isSearchingApi ? (
            <div className="flex justify-center py-20">
              <div className="w-8 h-8 border-3 border-[#4285F4] border-t-transparent rounded-full animate-spin"></div>
            </div>
          ) : searchQuery.trim() && filteredFolders.length === 0 && apiSearchResults.length === 0 && !isSearchingApi ? (
            <div className="text-center py-20 text-gray-500">
              <Search className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <h3 className="text-lg font-medium mb-1 text-gray-900 dark:text-gray-200">{t('drive.no_folders')}</h3>
            </div>
          ) : searchQuery.trim() && (apiSearchResults.length > 0 || isSearchingApi) ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredFolders.map(folder => (
                <FolderCard
                  key={folder.id}
                  folder={folder}
                  onClick={() => handleOpenFolder(folder.id, folder.name)}
                />
              ))}
              {filteredFolders.length > 0 && (
                <div className="col-span-full text-[11px] font-bold text-gray-400 uppercase tracking-wider pt-2 pb-1">
                  {t('folder_selection.from_subfolders')}
                </div>
              )}
              {apiSearchResults.map(folder => (
                <FolderCard
                  key={folder.id}
                  folder={folder}
                  onClick={() => handleOpenFolder(folder.id, folder.name)}
                />
              ))}
              {isSearchingApi && (
                <div className="col-span-full flex items-center justify-center gap-2 py-4 text-sm text-gray-400">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('folder_selection.searching_deeper')}
                </div>
              )}
            </div>
          ) : !searchQuery.trim() && filteredFolders.length === 0 && !isLoading ? (
            <div className="text-center py-20 text-gray-500">
              <Folder className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <h3 className="text-lg font-medium mb-1 text-gray-900 dark:text-gray-200">{t('drive.no_folders')}</h3>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredFolders.map(folder => (
                <FolderCard
                  key={folder.id}
                  folder={folder}
                  onClick={() => handleOpenFolder(folder.id, folder.name)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 flex items-center justify-end gap-3 shrink-0">
          {onCancel && (
            <button 
              onClick={onCancel}
              className="px-5 py-2.5 rounded-xl text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              {t('folder_selection.cancel')}
            </button>
          )}
          <button 
            onClick={() => onSelectFolder(currentFolderId)}
            className="flex items-center gap-2 bg-[#4285F4] hover:bg-[#3367d6] text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-all transform active:scale-[0.98] shadow-sm"
          >
            <Check className="w-4 h-4" />
            {t('folder_selection.choose_folder')}
          </button>
        </div>
      </div>
    </div>
  );
}
