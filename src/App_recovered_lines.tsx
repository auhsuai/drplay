  };

  const [showFolderSelection, setShowFolderSelection] = useState(false);
  const [scanMode, setScanMode] = useState<'fast' | 'full'>('fast');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [highlightedFileId, setHighlightedFileId] = useState<{id: string, ts: number} | null>(null);
  const pendingEnsuredFileId = useRef<string | null>(null);
  const [isNowPlayingOpen, setIsNowPlayingOpen] = useState(false);




  // Locate File in App logic
  useEffect(() => {
    const handleLocateFile = async (e: any) => {
      const { fileId, alreadyInCurrentFolder } = e.detail || {};
      if (!fileId || !accessToken) return;

      const rebuildHistory = async (targetFolderId: string) => {
        const rootRaw = localStorage.getItem("drplay_root_folder");
        let rootId = 'root';
        if (rootRaw) {
          try { rootId = JSON.parse(rootRaw).id; } catch (e) { }
        }
        try {
          let current = targetFolderId;
          const newHistory: { id: string, name: string }[] = [];
          let limit = 10;
          while (current !== rootId && current !== 'root' && limit > 0) {
            limit--;
            const res = await fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${current}?fields=parents`, {
              headers: { Authorization: `Bearer ${accessToken}` }
            });
            if (!res.ok) break;
            const data = await res.json();
            if (!
              />
            ) : activeTab === "Liked Songs" ? (
              <LikedSongs onPlay={(t: Track, c: Track[]) => { handlePlayTrack(t, c); }} token={accessToken} currentTrack={currentTrack} />
            ) : activeTab.startsWith("playlist_") ? (
              <PlaylistView
                playlistId={activeTab.replace("playlist_", "")}
                onPlay={(t: Track, c?: Track[]) => { handlePlayTrack(t, c); }}
                onDelete={() => handleTabChange("Home")}
                currentTrack={currentTrack}
              />
            ) : activeTab === "Settings" ? (
              <SettingsTab
                theme={theme}
                setTheme={setTheme}
                bufferSeconds={bufferSeconds}
                setBufferSeconds={setBufferSeconds}
                scanMode={scanMode}
                setScanMode={setScanMode}
                setShowFolderSelection={setShowFolderSelection}
                setShowTrashScreen={setShowTrashScreen}
              />
            ) : (
              <main className="flex-1 bg-white dark:bg-[#121212] overflow-y-auto flex items-center justify-center transition-colors duration-300">
                <h1 className="text-2xl text-gray-500">Coming Soon: {activeTab}</h1>
              </main>
            )}

          </div>
        </div>