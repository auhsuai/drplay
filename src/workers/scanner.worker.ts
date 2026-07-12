import { get } from 'idb-keyval';
import { getTrackMetadata } from '../utils/metadata';

// Listen for messages from the main thread
self.onmessage = async (e: MessageEvent) => {
  const { token } = e.data;
  if (!token) return;
  
  await startScanner(token);
};

async function startScanner(token: string) {
  let pageToken: string | undefined = undefined;
  
  // Limit to 20 concurrent threads to maximize scan speed
  const MAX_CONCURRENT = 20;
  let activePromises: Promise<void>[] = [];
  
  const processFile = async (file: any) => {
    const fileId = file.id;
    const cacheKey = `metadata_${fileId}`;
    try {
      // Skip if file metadata is already fully parsed and cached.
      const cached = await get<{ version: number; data?: { v?: number }; ts: number }>(cacheKey);
      if (cached && cached.data && (cached.data.v ?? 0) >= 9) return;
    } catch (e) {}

    const knownSize = file.size ? parseInt(file.size, 10) : undefined;
    await getTrackMetadata(fileId, token, knownSize, file.name);
  };
  
  do {
    try {
      const url = new URL("https://www.googleapis.com/drive/v3/files");
      url.searchParams.append("q", "mimeType contains 'audio/' and trashed=false");
      url.searchParams.append("fields", "nextPageToken,files(id, size, name)");
      url.searchParams.append("pageSize", "1000"); // Fetch max 1000 files per page
      if (pageToken) url.searchParams.append("pageToken", pageToken);
      
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      const data = await res.json();
      const files = data.files || [];
      
      for (const file of files) {
        const p = processFile(file).finally(() => {
          activePromises = activePromises.filter(x => x !== p);
        });
        activePromises.push(p);
        
        // If running threads reach the limit, wait for one to finish
        if (activePromises.length >= MAX_CONCURRENT) {
          await Promise.race(activePromises);
          
          // YIELD MECHANISM: 
          // Allow the worker's event loop to breathe, process pending messages,
          // and run Garbage Collection before the next heavy parse cycle.
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      
      pageToken = data.nextPageToken;
    } catch (e) {
      console.warn("Global scanner error:", e);
      break;
    }
  } while (pageToken);
  
  // Wait for the last remaining threads to complete
  await Promise.allSettled(activePromises);
  console.log("Global Background Scanner (Worker) completed successfully.");
}
