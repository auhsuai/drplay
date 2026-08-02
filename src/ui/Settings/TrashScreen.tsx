import { useState, useEffect, useRef } from 'react';
import { Trash2, X, RefreshCw, Loader2, AlertTriangle, FileAudio, Folder, Check, CheckSquare, MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { restoreFile, permanentlyDeleteFile } from '../../utils/driveApi';
import { getTrashedFiles } from '../../utils/drivePagination';
import { showErrorToast, showSuccessToast } from '../../utils/simpleToast';
import { captureError } from '../../utils/errorLog';

const TRASH_MODULE = 'TrashScreen';

interface TrashScreenProps {
  token: string;
  onClose: () => void;
}

interface TrashedItem {
  id: string;
  name: string;
  mimeType: string;
}

export function TrashScreen({ token, onClose }: TrashScreenProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<TrashedItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isEmptying, setIsEmptying] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  
  // Selection states
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkActioning, setIsBulkActioning] = useState(false);

  // More menu state
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setIsMoreMenuOpen(false);
      }
    };
    if (isMoreMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isMoreMenuOpen]);

  const fetchTrashed = async () => {
    setIsLoading(true);
    try {
      // Fetch trashed audio files and folders that were deleted by DrPlay
      const q = "trashed=true and appProperties has { key='deletedByDrPlay' and value='true' }";
      const files = await getTrashedFiles(token, q);
      setItems(files.map((f: TrashedItem) => ({ id: f.id, name: f.name, mimeType: f.mimeType })));
    } catch (e) {
      captureError({ level: 'error', source: TRASH_MODULE, message: `fetch-trashed-failed: ${e instanceof Error ? e.message : String(e)}` });
      showErrorToast(t('settings.trash_load_error') || "Failed to load trash");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTrashed();
  }, [token]);

  const handleRestore = async (id: string) => {
    setRestoringId(id);
    try {
      await restoreFile(token, id);
      setItems(prev => prev.filter(item => item.id !== id));
      window.dispatchEvent(new CustomEvent('refresh-drive'));
    } catch (e) {
      captureError({ level: 'error', source: TRASH_MODULE, message: `restore-failed: ${e instanceof Error ? e.message : String(e)}` });
      showErrorToast(t('settings.restore_error') || "Failed to restore file");
    } finally {
      setRestoringId(null);
    }
  };

  const handleEmptyTrash = async () => {
    if (!window.confirm(t('settings.confirm_empty_trash') || 'Are you sure you want to permanently delete all trashed items? This cannot be undone.')) {
      return;
    }
    setIsEmptying(true);
    try {
      const deletePromises = items.map(item => permanentlyDeleteFile(token, item.id));
      await Promise.all(deletePromises);
      setItems([]);
      showSuccessToast(t('settings.empty_trash_success') || "Trash emptied successfully!");
      onClose();
    } catch (e) {
      captureError({ level: 'error', source: TRASH_MODULE, message: `empty-trash-failed: ${e instanceof Error ? e.message : String(e)}` });
      showErrorToast(t('settings.empty_trash_error') || "Failed to empty trash");
    } finally {
      setIsEmptying(false);
    }
  };

  const handleBulkRestore = async () => {
    if (selectedIds.size === 0) return;
    setIsBulkActioning(true);
    try {
      const ids = Array.from(selectedIds);
      await Promise.all(ids.map(id => restoreFile(token, id)));
      setItems(prev => prev.filter(item => !selectedIds.has(item.id)));
      window.dispatchEvent(new CustomEvent('refresh-drive'));
      setSelectedIds(new Set());
      setIsSelectionMode(false);
    } catch (e) {
      captureError({ level: 'error', source: TRASH_MODULE, message: `bulk-restore-failed: ${e instanceof Error ? e.message : String(e)}` });
      showErrorToast(t('settings.restore_error') || "Failed to restore items");
    } finally {
      setIsBulkActioning(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setIsBulkActioning(true);
    try {
      const ids = Array.from(selectedIds);
      await Promise.all(ids.map(id => permanentlyDeleteFile(token, id)));
      setItems(prev => prev.filter(item => !selectedIds.has(item.id)));
      setSelectedIds(new Set());
      setIsSelectionMode(false);
    } catch (e) {
      captureError({ level: 'error', source: TRASH_MODULE, message: `bulk-delete-failed: ${e instanceof Error ? e.message : String(e)}` });
      showErrorToast(t('settings.empty_trash_error') || "Failed to delete items");
    } finally {
      setIsBulkActioning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div 
        className="bg-white dark:bg-[#121212] w-full max-w-2xl h-[70vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-5 flex items-center justify-between shrink-0 bg-gray-50/50 dark:bg-[#1a1b1e]/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#4285F4]/10 flex items-center justify-center shrink-0">
              <svg className="w-5 h-5 text-[#4285F4]" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            </div>
            <div>
              <h1 className="text-lg font-bold text-gray-900 dark:text-white">
                {t('settings.trash')}
              </h1>
              <p className="text-xs text-gray-500 mt-0.5">
                {t('settings.trash_desc')}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-900 dark:hover:text-white rounded-full transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-4 bg-white dark:bg-[#121212]">
          {isLoading ? (
            <div className="flex justify-center py-20">
              <div className="w-8 h-8 border-3 border-[#4285F4] border-t-transparent rounded-full animate-spin"></div>
            </div>
          ) : items.length === 0 ? (
            <div className="text-center py-20 text-gray-500 flex flex-col items-center">
              <Trash2 className="w-16 h-16 mb-4 opacity-20" />
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-200">{t('settings.trash_empty')}</h3>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between px-1 py-3 mb-2">
                <div className="flex items-center gap-2 text-sm text-[#4285F4] font-medium">
                  <AlertTriangle className="w-5 h-5 shrink-0" />
                  <p>{t('settings.trash_warning')}</p>
                </div>
                <div className="relative" ref={moreMenuRef}>
                  {isSelectionMode ? (
                    <button 
                      onClick={() => {
                        setIsSelectionMode(false);
                        setSelectedIds(new Set());
                      }}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors flex items-center gap-2"
                    >
                      {t('common.cancel') || 'Cancel'}
                    </button>
                  ) : (
                    <button 
                      onClick={() => setIsMoreMenuOpen(!isMoreMenuOpen)}
                      className="p-1.5 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                    >
                      <MoreHorizontal className="w-5 h-5" />
                    </button>
                  )}
                  
                  {isMoreMenuOpen && !isSelectionMode && (
                    <div className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-[#2a2b2f] rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-gray-100 dark:border-white/5 p-1 z-50 animate-in fade-in zoom-in-95 duration-200">
                      <button
                        onClick={() => {
                          setIsSelectionMode(true);
                          setIsMoreMenuOpen(false);
                        }}
                        className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors group"
                      >
                        <CheckSquare className="w-4 h-4 text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-300 transition-colors" />
                        <span className="text-gray-700 dark:text-gray-200 group-hover:text-gray-900 dark:group-hover:text-white transition-colors">
                          {t('menu.select_multiple', 'Chọn nhiều mục')}
                        </span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {items.map(item => {
                const isFolder = item.mimeType === 'application/vnd.google-apps.folder';
                const isSelected = selectedIds.has(item.id);
                return (
                  <div 
                    key={item.id} 
                    className={`flex items-center justify-between p-3 rounded-xl transition-colors ${
                      isSelectionMode ? 'cursor-pointer' : ''
                    } ${
                      isSelected ? 'bg-[#4285F4]/10 border border-[#4285F4]/30' : 'bg-gray-50 dark:bg-[#202124] hover:bg-gray-100 dark:hover:bg-[#2a2b2f] border border-transparent'
                    }`}
                    onClick={() => {
                      if (isSelectionMode) {
                        setSelectedIds(prev => {
                          const newSet = new Set(prev);
                          if (newSet.has(item.id)) newSet.delete(item.id);
                          else newSet.add(item.id);
                          return newSet;
                        });
                      }
                    }}
                  >
                    <div className="flex items-center gap-3 overflow-hidden">
                      {isSelectionMode && (
                        <div className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition-colors ${
                          isSelected ? 'bg-[#4285F4] border-[#4285F4]' : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-black/20'
                        }`}>
                          {isSelected && <Check className="w-3.5 h-3.5 text-white" />}
                        </div>
                      )}
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${isFolder ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-500' : 'bg-[#4285F4]/10 text-[#4285F4]'}`}>
                        {isFolder ? <Folder className="w-5 h-5" fill="currentColor" /> : <FileAudio className="w-5 h-5" />}
                      </div>
                      <div className="overflow-hidden">
                        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate max-w-[250px] sm:max-w-sm">{item.name}</h4>
                      </div>
                    </div>
                    {!isSelectionMode && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleRestore(item.id); }}
                        disabled={restoringId === item.id}
                        className="px-4 py-1.5 text-xs font-semibold text-green-600 bg-green-50 hover:bg-green-100 dark:bg-green-900/20 dark:hover:bg-green-900/40 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 shrink-0"
                      >
                        {restoringId === item.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                        <span className="hidden sm:inline">{t('settings.restore')}</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 flex items-center justify-between bg-gray-50/50 dark:bg-[#1a1b1e]/50 shrink-0">
          {isSelectionMode ? (
            <>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {selectedIds.size} {(t('common.selected') || 'selected')}
              </p>
              <div className="flex items-center gap-3">
                <button 
                  onClick={handleBulkRestore}
                  disabled={selectedIds.size === 0 || isBulkActioning}
                  className="px-4 py-2.5 bg-[#4285F4] text-white rounded-xl text-sm font-medium hover:bg-[#3367d6] disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  {isBulkActioning ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  <span className="hidden sm:inline">{t('settings.restore') || 'Restore'}</span>
                </button>
                <button 
                  onClick={handleBulkDelete}
                  disabled={selectedIds.size === 0 || isBulkActioning}
                  className="px-4 py-2.5 bg-red-500 text-white rounded-xl text-sm font-medium hover:bg-red-600 disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  {isBulkActioning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  <span className="hidden sm:inline">{t('common.delete') || 'Delete'}</span>
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-gray-500 hidden sm:block">
                {items.length > 0 ? `${items.length} ${t('settings.items_in_trash')}` : ''}
              </p>
              <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
                <button 
                  onClick={onClose}
                  className="px-5 py-2.5 rounded-xl text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
                >
                  {t('folder_selection.cancel')}
                </button>
                <button 
                  onClick={handleEmptyTrash}
                  disabled={items.length === 0 || isEmptying}
                  className="flex items-center justify-center gap-2 bg-red-500 hover:bg-red-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-all transform active:scale-[0.98] shadow-sm disabled:opacity-50 disabled:cursor-not-allowed w-full sm:w-auto"
                >
                  {isEmptying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  {t('settings.empty_trash')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
