//! Killing a language server and everything it started.
//!
//! `Child::kill` ends one process. On POSIX that is enough, because a language
//! server *is* the process we spawned: a shebang script runs under the `node`
//! we started, and a compiled server has no launcher in front of it.
//!
//! **Windows is different, and it is the same difference `terminal/pty.rs`
//! already documents.** Every Node-based server installs its entry point as a
//! `.cmd` shim, so the process we spawn is `cmd.exe`, and the server itself is
//! `node.exe` one level below it. `TerminateProcess` on `cmd.exe` leaves that
//! `node.exe` running, attached to pipes nobody holds — an orphaned
//! `typescript-language-server` per stop, and no way to see it short of Task
//! Manager.
//!
//! A **job object** is the platform's answer: a kill-group a process is
//! assigned to, where terminating the job terminates everything in it. With
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` the group also dies when the handle
//! closes, which covers the case `stop` never runs at all — a panic, or the app
//! being killed outright.
//!
//! One job per server rather than one for the app, because stopping *one*
//! server must not take the others with it.

use std::process::Child;

/// A kill-group for one server and its descendants.
///
/// A no-op everywhere but Windows, so `server.rs` carries no platform branches:
/// it always creates a group, always adopts the child, and always terminates
/// both the group and the child. On POSIX the group calls do nothing and
/// `Child::kill` remains the mechanism.
pub struct ProcessGroup {
    #[cfg(windows)]
    handle: Option<windows::JobHandle>,
}

impl ProcessGroup {
    pub fn new() -> Self {
        Self {
            #[cfg(windows)]
            handle: windows::JobHandle::create(),
        }
    }

    /// Puts a freshly spawned child into the group.
    ///
    /// There is an unavoidable gap between `CreateProcess` returning and this
    /// running, during which the child could spawn a grandchild that escapes.
    /// Closing it properly needs `CREATE_SUSPENDED` and a handle to the initial
    /// thread, which `std::process::Command` does not expose. In practice the
    /// gap is the microseconds before `cmd.exe` has read its own batch file,
    /// and assignment is the first thing done after spawning.
    #[cfg_attr(not(windows), allow(unused_variables))]
    pub fn adopt(&self, child: &Child) {
        #[cfg(windows)]
        if let Some(handle) = &self.handle {
            handle.adopt(child);
        }
    }

    /// Ends every process in the group.
    ///
    /// Safe to call more than once, and safe to call on a group whose processes
    /// have already exited.
    pub fn terminate(&self) {
        #[cfg(windows)]
        if let Some(handle) = &self.handle {
            handle.terminate();
        }
    }
}

impl Default for ProcessGroup {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(windows)]
mod windows {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, TerminateJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct JobHandle(HANDLE);

    /*
      A job handle is just a kernel handle — it has no thread affinity, and the
      Windows API is explicit that handles may be used from any thread. The
      compiler cannot know that, and `Server` is shared across the reader
      thread, the reaper thread and Tauri's command threads.
    */
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    impl JobHandle {
        /// `None` when the job could not be created, in which case the caller
        /// falls back to killing the one process it knows about — the old
        /// behaviour, which is worse but not broken.
        pub fn create() -> Option<Self> {
            // SAFETY: both arguments are optional per the API; null means "no
            // security attributes, unnamed".
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                log::warn!("lsp: could not create a job object; servers may outlive a stop");
                return None;
            }

            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION =
                unsafe { std::mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            // SAFETY: `limits` is a correctly sized, fully initialised value of
            // the type the information class names.
            let set = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    std::ptr::addr_of!(limits).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };

            if set == 0 {
                // Without the limit the group still kills on demand; it just
                // won't clean up if we never ask. Worth keeping, worth saying.
                log::warn!("lsp: job object has no kill-on-close limit");
            }

            Some(Self(handle))
        }

        pub fn adopt(&self, child: &Child) {
            // SAFETY: the handle is owned by `child`, which outlives this call.
            let assigned =
                unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
            if assigned == 0 {
                log::warn!("lsp: could not put server {} in its job object", child.id());
            }
        }

        pub fn terminate(&self) {
            // SAFETY: a valid job handle; the exit code is arbitrary. Already
            // dead processes are not an error.
            unsafe { TerminateJobObject(self.0, 1) };
        }
    }

    impl Drop for JobHandle {
        fn drop(&mut self) {
            // With `KILL_ON_JOB_CLOSE` set, this is also what ends the tree when
            // `stop` never ran — a panic, or the app being killed outright.
            // SAFETY: the handle is owned and closed exactly once.
            unsafe { CloseHandle(self.0) };
        }
    }
}
