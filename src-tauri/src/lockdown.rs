//! Makes the web view behave like an app window, not a browser: no browser
//! context menu, no browser shortcuts (find, print, reload, zoom, view source,
//! save page, DevTools, back/forward), no autofill or "save password" prompts,
//! no zoom or swipe navigation. Text editing keys (copy, paste, cut, select all,
//! undo) still work in inputs. Text selection is turned off in CSS (src/index.css).

use tauri::WebviewWindow;

pub fn apply(window: &WebviewWindow) {
    #[cfg(windows)]
    {
        let result = window.with_webview(|webview| {
            // SAFETY: plain WebView2 COM calls, run by Tauri on the web view's own thread.
            if let Err(e) = unsafe { windows::apply(&webview.controller()) } {
                eprintln!("Could not lock down the web view: {e}");
            }
        });
        if let Err(e) = result {
            eprintln!("Could not reach the web view to lock it down: {e}");
        }
    }
    #[cfg(not(windows))]
    let _ = window;
}

#[cfg(windows)]
mod windows {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Controller, ICoreWebView2Settings3, ICoreWebView2Settings4, ICoreWebView2Settings5,
        ICoreWebView2Settings6,
    };
    use windows_core::{Interface, Result};

    pub unsafe fn apply(controller: &ICoreWebView2Controller) -> Result<()> {
        let webview = controller.CoreWebView2()?;
        let settings = webview.Settings()?;

        settings.SetAreDefaultContextMenusEnabled(false)?;
        settings.SetIsZoomControlEnabled(false)?;
        settings.SetIsStatusBarEnabled(false)?;
        settings.cast::<ICoreWebView2Settings3>()?.SetAreBrowserAcceleratorKeysEnabled(false)?;

        // Older WebView2 runtimes lack these; the settings above are the important ones.
        if let Ok(settings) = settings.cast::<ICoreWebView2Settings4>() {
            settings.SetIsGeneralAutofillEnabled(false)?;
            settings.SetIsPasswordAutosaveEnabled(false)?;
        }
        if let Ok(settings) = settings.cast::<ICoreWebView2Settings5>() {
            settings.SetIsPinchZoomEnabled(false)?;
        }
        if let Ok(settings) = settings.cast::<ICoreWebView2Settings6>() {
            settings.SetIsSwipeNavigationEnabled(false)?;
        }

        // No Reload() here: this runs before the first page has committed, and a
        // reload then cancels that navigation and leaves the window on about:blank.
        // Settings applied now already hold for that first page.
        Ok(())
    }
}
