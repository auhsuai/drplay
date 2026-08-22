// Secure storage for the Google OAuth refresh token.
//
// WHY this exists: the refresh token is a long-lived credential — anyone who
// holds it can mint new access tokens and take over the user's Google Drive
// account permanently. Google's OAuth best practices require storing it
// securely (https://developers.google.com/identity/protocols/oauth2/resources/best-practices),
// so it lives in the OS credential vault — Windows Credential Manager via the
// `keyring` crate (v1 feature auto-selects the platform store), and the
// Android Keystore-backed SharedPreferences store on Android — instead of
// plaintext WebView localStorage, which any XSS could exfiltrate.
//
// The short-lived access token (~1h expiry) intentionally stays in the
// frontend (localStorage): its exposure window is bounded, and keeping it
// client-side avoids a backend round-trip on every API call.
//
// Android specifics: keyring's v1 one-time store initializer has no Android
// arm (keyring-4.1.6 src/v1.rs:109-129), so `keyring::Entry::new` always
// fails with NoDefaultStore there. We therefore bypass v1 on Android and call
// `keyring_core` directly after installing the Android Keystore store as the
// default (see `android_keystore`). The `android-native-keyring-store` crate
// also requires the ndk-context application-context to be initialized; tauri
// 2.11/tao 0.35 no longer does that (upstream issue
// open-source-cooperative/android-native-keyring-store#21), so we initialize
// it ourselves from Rust via `JNI_OnLoad` (ART hands the process JavaVM to
// it on library load — `JNI_GetCreatedJavaVMs` is not exported on Android)
// plus reflection, with no Kotlin changes and no extra .so needed.
#[cfg(not(target_os = "android"))]
use keyring::Entry;

use base64::Engine as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// One-time initialization cache shared by the Android Keystore setup
/// (audit B-1): a SUCCESS is remembered exactly once per process, while a
/// failure is never stored — the very next caller retries, so a transient
/// startup race or Keystore hiccup cannot poison the vault until restart.
///
/// Extracted as a platform-independent type so its caching policy is
/// unit-testable off-device; production only uses it on Android, hence the
/// dead_code allowance on other targets.
#[allow(dead_code)]
struct RetryableInit {
    /// Published once `init` has succeeded; Acquire/Release pairs make the
    /// completion visible to every later caller (see std::sync::atomic docs).
    completed_ok: AtomicBool,
    /// Serializes attempts so concurrent callers cannot double-run `init`
    /// while a success has not been published yet.
    lock: Mutex<()>,
}

#[allow(dead_code)]
impl RetryableInit {
    const fn new() -> Self {
        Self {
            completed_ok: AtomicBool::new(false),
            lock: Mutex::new(()),
        }
    }

    fn ensure(&self, init: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
        // Fast path: a completed init stays published for all later callers.
        if self.completed_ok.load(Ordering::Acquire) {
            return Ok(());
        }
        let _guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        // Re-check under the lock: another thread may have finished `init`
        // between the fast path and acquiring the lock.
        if !self.completed_ok.load(Ordering::Acquire) {
            match init() {
                Ok(()) => self.completed_ok.store(true, Ordering::Release),
                // Deliberately NOT remembered: the next call retries `init`.
                Err(err) => return Err(err),
            }
        }
        Ok(())
    }
}

/// Service name under which the refresh token is stored in the OS keychain.
const SERVICE_NAME: &str = "drplay";
/// Entry key (username) under the service: the app uses a single Google
/// account at a time, so a fixed key is sufficient.
const REFRESH_TOKEN_USER: &str = "refresh_token";
/// Entry key for the DPoP (RFC 9449) private key that the refresh token is
/// bound to (base64url-encoded PKCS#8 DER). Stored under the same service but
/// a different username so it never collides with the token entry.
const DPOP_KEY_USER: &str = "dpop_key";

/// The keyring entry type: v1 `keyring::Entry` on desktop, and
/// `keyring_core::Entry` on Android (v1's `Entry::new` cannot work there —
/// see module docs). Both expose the same set/get/delete methods and the same
/// `keyring_core::Error` type, so the command bodies below are shared.
#[cfg(not(target_os = "android"))]
type VaultEntry = Entry;
#[cfg(target_os = "android")]
type VaultEntry = keyring_core::Entry;

#[cfg(target_os = "android")]
mod android_keystore {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    use jni::objects::GlobalRef;
    use jni::sys::jint;
    use jni::JavaVM;

    use super::RetryableInit;

    /// One-time cache for the Android Keystore store initialization: only a
    /// success is remembered; failures stay retryable (audit B-1). The `Err`
    /// never contains credential material (no token).
    static INIT_CACHE: RetryableInit = RetryableInit::new();

    /// Set once `ndk_context::initialize_android_context` has run. That
    /// function asserts it is never called twice (ndk-context 0.1.1
    /// src/lib.rs:82-88), so a retried init attempt — allowed since audit
    /// B-1 after an earlier attempt failed later in the pipeline — must skip
    /// this step instead of panicking.
    static NDK_CONTEXT_READY: AtomicBool = AtomicBool::new(false);

    /// The process JavaVM, captured by `JNI_OnLoad` (see below). ART calls
    /// `JNI_OnLoad` with the VM pointer the moment `System.loadLibrary`
    /// succeeds — before any Rust command can run — so this is always set by
    /// the time a command touches the credential store.
    static JAVA_VM: Mutex<Option<JavaVM>> = Mutex::new(None);

    /// JNI entry point ART invokes right after `System.loadLibrary` loads this
    /// .so. It is the only guaranteed way to obtain the process JavaVM on
    /// Android: `JNI_GetCreatedJavaVMs` is NOT an exported symbol of libart,
    /// so referencing it makes the dynamic linker fail the entire library with
    /// `UnsatisfiedLinkError` (`dlopen failed: cannot locate symbol
    /// "JNI_GetCreatedJavaVMs"`) — the startup crash this module used to
    /// cause. Returns the minimum JNI version the code supports.
    #[no_mangle]
    pub extern "system" fn JNI_OnLoad(vm: JavaVM, _reserved: *mut c_void) -> jint {
        match JAVA_VM.lock() {
            Ok(mut guard) => *guard = Some(vm),
            // Poisoning is unreachable (no panic while the lock is held); take
            // the lock back rather than aborting across the FFI boundary.
            Err(poisoned) => *poisoned.into_inner() = Some(vm),
        }
        jni::sys::JNI_VERSION_1_6
    }

    /// Install the Android Keystore credential store as the keyring default,
    /// exactly once per process. Returns a contextual error on any failure.
    pub fn ensure() -> Result<(), String> {
        INIT_CACHE.ensure(initialize)
    }

    fn initialize() -> Result<(), String> {
        let vm = find_java_vm()?;
        let context = find_application_context(&vm)?;
        // SAFETY: `initialize_android_context` asserts it is called at most
        // once (ndk-context 0.1.1 src/lib.rs:82-88); NDK_CONTEXT_READY keeps
        // a retried attempt from re-running it when an earlier attempt got
        // past this point and then failed (e.g. Store::new()). The VM pointer
        // stays valid for the process lifetime, and the context is a global
        // ref we deliberately leak so it outlives any activity recreation.
        // INIT_CACHE serializes attempts, so no two threads race this check.
        if !NDK_CONTEXT_READY.load(Ordering::Acquire) {
            unsafe {
                ndk_context::initialize_android_context(
                    vm.get_java_vm_pointer().cast(),
                    context,
                );
            }
            NDK_CONTEXT_READY.store(true, Ordering::Release);
        }
        let store = android_native_keyring_store::Store::new()
            .map_err(|e| format!("Android Keystore store creation failed: {e}"))?;
        keyring_core::set_default_store(store);
        Ok(())
    }

    /// Return the process JavaVM captured by `JNI_OnLoad`. The JNI invocation
    /// API's `JNI_GetCreatedJavaVMs` cannot be used on Android (libart does
    /// not export the symbol — see `JNI_OnLoad` above). The VM pointer is
    /// valid for the process lifetime, so re-wrapping it on each call is safe.
    fn find_java_vm() -> Result<JavaVM, String> {
        let guard = match JAVA_VM.lock() {
            Ok(g) => g,
            // Poisoning is unreachable (no panic while the lock is held).
            Err(poisoned) => poisoned.into_inner(),
        };
        let vm = guard.as_ref().ok_or_else(|| {
            "JNI_OnLoad not called yet (no JavaVM captured by ART)".to_string()
        })?;
        // SAFETY: `from_raw` only null-checks (jni-0.21.1
        // src/wrapper/java_vm/vm.rs:239-244); the captured VM pointer remains
        // valid for the process lifetime.
        unsafe { JavaVM::from_raw(vm.get_java_vm_pointer()) }.map_err(|e| e.to_string())
    }

    /// Obtain the application `Context` via `ActivityThread.currentApplication()`
    /// and return it as a process-lifetime global ref (deliberately leaked).
    fn find_application_context(vm: &JavaVM) -> Result<*mut c_void, String> {
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let class = env
            .find_class("android/app/ActivityThread")
            .map_err(|e| format!("android/app/ActivityThread not found: {e}"))?;
        let app = env
            .call_static_method(class, "currentApplication", "()Landroid/app/Application;", &[])
            .map_err(|e| format!("ActivityThread.currentApplication() failed: {e}"))?
            .l()
            .map_err(|e| format!("ActivityThread.currentApplication() result invalid: {e}"))?;
        if app.is_null() {
            return Err(
                "ActivityThread.currentApplication() returned null (app not yet initialized)"
                    .to_string(),
            );
        }
        let global: GlobalRef = env
            .new_global_ref(&app)
            .map_err(|e| format!("failed to hold the application context: {e}"))?;
        let raw = global.as_obj().as_raw() as *mut c_void;
        std::mem::forget(global); // keep the context alive for the process lifetime
        Ok(raw)
    }
}

/// Open a vault entry under the app's service for the given user/key name.
/// On Android the Keystore store must be installed before any entry is
/// created; desktop resolves to a no-op because this cfg is absent.
fn vault_entry(user: &str) -> Result<VaultEntry, String> {
    #[cfg(target_os = "android")]
    android_keystore::ensure()?;
    VaultEntry::new(SERVICE_NAME, user).map_err(|e| {
        format!("failed to open OS credential vault entry (service \"{SERVICE_NAME}\"): {e}")
    })
}

fn refresh_token_entry() -> Result<VaultEntry, String> {
    vault_entry(REFRESH_TOKEN_USER)
}

/// Persist the Google OAuth refresh token in the OS credential vault.
///
/// `(async)` keeps the synchronous body but moves execution off the main
/// thread (Tauri v2 docs, "Async Commands"): keyring IO must never block UI.
#[tauri::command(async)]
pub fn set_refresh_token(token: String) -> Result<(), String> {
    let entry = refresh_token_entry()?;
    entry.set_password(&token).map_err(|e| {
        // Never include the token in the error: it is a long-lived secret.
        format!("failed to store refresh token in the OS credential vault: {e}")
    })
}

/// Read the persisted refresh token, or `None` when nothing is stored.
///
/// Runs off the main thread via `#[tauri::command(async)]` (keyring IO).
#[tauri::command(async)]
pub fn get_refresh_token() -> Result<Option<String>, String> {
    let entry = refresh_token_entry()?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        // No stored credential is the normal "signed out" state, not an error.
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!(
            "failed to read refresh token from the OS credential vault: {e}"
        )),
    }
}

/// Delete the persisted refresh token; a missing entry is not an error.
///
/// Logout must also drop the DPoP key the refresh token was bound to: the
/// token is gone, so the key is orphaned, and the next login should start
/// with a fresh pair. A vault hiccup here must NOT fail the logout itself —
/// the refresh token (the credential that matters) is already deleted by then.
///
/// Runs off the main thread via `#[tauri::command(async)]` (keyring IO).
#[tauri::command(async)]
pub fn delete_refresh_token() -> Result<(), String> {
    let entry = refresh_token_entry()?;
    let result = match entry.delete_credential() {
        Ok(()) => Ok(()),
        // Deleting a credential that is already gone is idempotent.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!(
            "failed to delete refresh token from the OS credential vault: {e}"
        )),
    };
    if let Err(e) = delete_dpop_key() {
        eprintln!("[drplay:token_store] failed to delete DPoP key during logout: {e}");
    }
    result
}

/// Persist the DPoP private key (PKCS#8 DER) in the OS credential vault.
/// The keyring API stores strings, so the binary DER is base64url-encoded.
pub fn set_dpop_key(der: &[u8]) -> Result<(), String> {
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(der);
    let entry = vault_entry(DPOP_KEY_USER)?;
    entry.set_password(&encoded).map_err(|e| {
        format!("failed to store DPoP key in the OS credential vault: {e}")
    })
}

/// Read the persisted DPoP private key (decoded DER), or `None` when nothing
/// is stored (normal before the first login, or after logout).
pub fn get_dpop_key() -> Result<Option<Vec<u8>>, String> {
    let entry = vault_entry(DPOP_KEY_USER)?;
    match entry.get_password() {
        Ok(encoded) => base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded.as_bytes())
            .map(Some)
            .map_err(|e| format!("failed to decode stored DPoP key: {e}")),
        // No stored credential is the normal "never logged in / logged out"
        // state, not an error.
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!(
            "failed to read DPoP key from the OS credential vault: {e}"
        )),
    }
}

/// Delete the persisted DPoP key; a missing entry is not an error.
pub fn delete_dpop_key() -> Result<(), String> {
    let entry = vault_entry(DPOP_KEY_USER)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!(
            "failed to delete DPoP key from the OS credential vault: {e}"
        )),
    }
}

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use super::*;

    /// Point the keyring default store at the in-memory mock store so the
    /// commands above can be exercised without touching the OS vault.
    ///
    /// The keyring v1 one-time platform store init is warmed up FIRST: on
    /// desktop it runs on the first `Entry::new` and would otherwise overwrite
    /// our mock with the real platform store (keyring-4.1.6 src/v1.rs:107-129).
    fn use_mock_store() {
        let _ = Entry::store_status();
        let store = keyring_core::mock::Store::new().expect("mock store creation");
        keyring_core::set_default_store(store);
    }

    #[test]
    fn set_then_get_roundtrips() {
        use_mock_store();
        assert_eq!(set_refresh_token("token-abc".to_string()), Ok(()));
        assert_eq!(get_refresh_token(), Ok(Some("token-abc".to_string())));
    }

    #[test]
    fn get_without_entry_returns_none() {
        use_mock_store();
        assert_eq!(get_refresh_token(), Ok(None));
    }

    #[test]
    fn delete_missing_entry_is_ok() {
        use_mock_store();
        assert_eq!(delete_refresh_token(), Ok(()));
    }

    #[test]
    fn delete_then_get_returns_none() {
        use_mock_store();
        set_refresh_token("token-xyz".to_string()).expect("set");
        assert_eq!(delete_refresh_token(), Ok(()));
        assert_eq!(get_refresh_token(), Ok(None));
    }

    #[test]
    fn dpop_key_set_then_get_roundtrips_binary_safely() {
        use_mock_store();
        // Non-UTF-8 bytes must survive the string-only keyring API intact.
        let der: Vec<u8> = vec![0x30, 0x81, 0xff, 0x00, 0x80, 0xfe];
        assert_eq!(set_dpop_key(&der), Ok(()));
        assert_eq!(get_dpop_key(), Ok(Some(der)));
    }

    #[test]
    fn dpop_key_get_without_entry_returns_none() {
        use_mock_store();
        assert_eq!(get_dpop_key(), Ok(None));
    }

    #[test]
    fn dpop_key_delete_then_get_returns_none() {
        use_mock_store();
        set_dpop_key(&[0xaa, 0xbb, 0xcc]).expect("set");
        assert_eq!(delete_dpop_key(), Ok(()));
        assert_eq!(get_dpop_key(), Ok(None));
    }

    #[test]
    fn delete_refresh_token_also_deletes_dpop_key() {
        use_mock_store();
        set_refresh_token("token-rt".to_string()).expect("set rt");
        set_dpop_key(&[0x11, 0x22, 0x33]).expect("set key");
        assert_eq!(delete_refresh_token(), Ok(()));
        assert_eq!(get_refresh_token(), Ok(None));
        assert_eq!(get_dpop_key(), Ok(None));
    }
}

#[cfg(all(test, not(target_os = "android")))]
mod init_cache_tests {
    use std::cell::Cell;

    use super::RetryableInit;

    /// Regression test for audit B-1: a transient Keystore init failure (e.g.
    /// `JNI_OnLoad` not yet run / `currentApplication()` null during startup
    /// race) must NOT be cached — the next caller retries — while a success IS
    /// cached so `initialize` still runs exactly once per process.
    #[test]
    fn failed_init_retries_on_next_call_and_success_is_cached() {
        let cache = RetryableInit::new();
        let attempts = Cell::new(0u32);

        // Attempt 1: transient failure (no credential material in the error).
        let first = cache.ensure(|| {
            attempts.set(attempts.get() + 1);
            Err("transient keystore hiccup".to_string())
        });
        assert_eq!(first, Err("transient keystore hiccup".to_string()));

        // Attempt 2 MUST re-run init; caching the Err would fail this call
        // forever with the stale error.
        let second = cache.ensure(|| {
            attempts.set(attempts.get() + 1);
            Ok(())
        });
        assert_eq!(second, Ok(()));
        assert_eq!(
            attempts.get(),
            2,
            "second ensure() call must retry after a failed attempt"
        );

        // After success, init is cached: no further runs, exactly-once kept.
        let third = cache.ensure(|| {
            attempts.set(attempts.get() + 1);
            Ok(())
        });
        assert_eq!(third, Ok(()));
        assert_eq!(
            attempts.get(),
            2,
            "a successful init must be cached (exactly-once preserved)"
        );
    }
}
