import React, { useState, useEffect } from 'react';
import { Folder, ArrowLeft, HardDrive, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { db } from '../../db/db';

interface FolderItem {
  id: string;
  name: string;
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
}

export function FolderSelectionScreen({ token, onSelectFolder, onCancel, initialFolderId = 'root', initialFolderName, initialFolderHistory = [], title, subtitle, appRootFolder }: FolderSelectionScreenProps) {
  const { t } = useTranslation();
  
  // Resolve appRootFolder from props or localStorage
  const resolvedAppRoot = appRootFolder || localStorage.getItem("drplay_root_folder");
  
  const [currentFolderId, setCurrentFolderId] = useState(initialFolderId === 'root' && resolvedAppRoot ? resolvedAppRoot : initialFolderId);
  const [currentFolderName, setCurrentFolderName] = useState(initialFolderName || t('drive.my_drive'));
  const [folderHistory, setFolderHistory] = useState<{id: string, name: string}[]>(initialFolderHistory);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    fetchFolders(currentFolderId);
    
    
    
    
  }, [currentFolderId, token]);

  const fetchFolders = async (folderId: string) => {
    setIsLoading(true);
    try {
      const dbFolders = await db.files.where('parentId').equals(folderId).filter(f => f.isFolder).toArray();
      if (dbFolders.length > 0) {
        setFolders(dbFolders.map(c => ({ id: c.id, name: c.name })));
      } else {
        const q = `'${folderId}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'`;
        const response = await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&orderBy=name`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        
        if (response.status === 401) {
          // Simple retry logic could go here, but App.tsx handles main token refresh.
          // For simplicity, we assume token is valid here.
        }

        if (response.ok) {
          const data = await response.json();
          setFolders(data.files || []);
        }
      }
    } catch (e) {
      console.error("Failed to fetch folders", e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenFolder = (folderId: string, folderName: string) => {
    setFolderHistory(prev => [...prev, { id: currentFolderId, name: currentFolderName }]);
    setCurrentFolderId(folderId);
    setCurrentFolderName(folderName);
  };

  const handleBack = async () => {
    if (folderHistory.length > 0) {
      const newHistory = [...folderHistory];
      const prevFolder = newHistory.pop()!;
      setFolderHistory(newHistory);
      setCurrentFolderId(prevFolder.id);
      setCurrentFolderName(prevFolder.name);
      return;
    }

    if (currentFolderId === 'root' || (resolvedAppRoot && currentFolderId === resolvedAppRoot)) return;

    setIsLoading(true);
    try {
      const response = await fetch(`https://www.googleapis.com/drive/v3/files/${currentFolderId}?fields=parents`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.ok) {
        const data = await response.json();
        if (data.parents && data.parents.length > 0) {
          const fetchedParentId = data.parents[0];
          setCurrentFolderId(fetchedParentId);
          try {
            const pRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fetchedParentId}?fields=name`, {
              headers: { Authorization: `Bearer ${token}` }
            });
            if (pRes.ok) {
              const pData = await pRes.json();
              setCurrentFolderName(pData.name);
            }
          } catch (e) {}
        } else {
          setCurrentFolderId('root');
        }
      } else {
        setCurrentFolderId('root');
        setCurrentFolderName('My Drive');
      }
    } catch (e) {
      console.error("Failed to fetch parent", e);
      setCurrentFolderId('root');
      setCurrentFolderName('My Drive');
    }
  };

  const handleBreadcrumbClick = (index: number) => {
    if (index === -1) {
      setFolderHistory([]);
      setCurrentFolderId(resolvedAppRoot || 'root');
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

        {/* Toolbar / Breadcrumb */}
        <div className="px-6 py-3 flex items-center gap-2 shrink-0 bg-gray-50/50 dark:bg-[#1a1b1e]/50 overflow-x-auto whitespace-nowrap hide-scrollbar">
          <button 
            onClick={handleBack}
            disabled={folderHistory.length === 0 && (currentFolderId === 'root' || currentFolderId === resolvedAppRoot)}
            className="p-1.5 mr-2 rounded-full hover:bg-gray-200 dark:hover:bg-gray-800 disabled:opacity-30 transition-colors shrink-0"
          >
            <ArrowLeft className="w-4 h-4 text-gray-700 dark:text-gray-300" />
          </button>
          
          <div className="flex items-center text-sm font-medium">
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

            <span className="text-gray-900 dark:text-white">
              {currentFolderName}
            </span>
          </div>
        </div>

        {/* Folder List */}
        <div className="flex-1 overflow-y-auto p-6 bg-white dark:bg-[#121212]">
          {isLoading ? (
            <div className="flex justify-center py-20">
              <div className="w-8 h-8 border-3 border-[#4285F4] border-t-transparent rounded-full animate-spin"></div>
            </div>
          ) : folders.length === 0 ? (
            <div className="text-center py-20 text-gray-500">
              <Folder className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <h3 className="text-lg font-medium mb-1 text-gray-900 dark:text-gray-200">{t('drive.no_folders')}</h3>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {folders.map(folder => (
                <div 
                  key={folder.id}
                  onClick={() => handleOpenFolder(folder.id, folder.name)}
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
