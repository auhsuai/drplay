import { invoke } from "@tauri-apps/api/core";

export async function testGetLocalMetadata() {
  try {
    const res = await invoke("get_local_metadata", { size: 686475573, name: "test" });
    console.log("get_local_metadata result:", res);
    alert("get_local_metadata result: " + JSON.stringify(res));
  } catch (e) {
    console.error("error:", e);
    alert("error: " + e);
  }
}
