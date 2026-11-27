//! The app menu. macOS: a native menu bar; every custom item emits the Tauri event `menu` with its id
//! (the frontend's `App.runCommand` handles it, `src/ui/appMenu.ts`). Windows / Linux: no native menu bar
//! (the window stays clean); the frontend shows the same structure from a ☰ button instead.
//!
//! Custom items have no accelerators on purpose: their shortcuts are handled (and remappable) in the webview,
//! and a menu accelerator would fire the action a second time. The predefined Edit items keep theirs, so
//! ⌘C / ⌘V / ⌘Z keep working in every text field.

use tauri::{Builder, Runtime};

#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuBuilder, PredefinedMenuItem, SubmenuBuilder};
#[cfg(target_os = "macos")]
use tauri::{AppHandle, Emitter};

/// Event sent to the frontend when a custom menu item is clicked; the payload is the item id.
pub const MENU_EVENT: &str = "menu";

/// Installs the native menu bar (macOS only; elsewhere the builder is returned unchanged).
#[cfg(target_os = "macos")]
pub fn with_app_menu<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder.menu(build::<R>).on_menu_event(|app, event| {
        let _ = app.emit(MENU_EVENT, event.id().0.clone());
    })
}

/// Installs the native menu bar (macOS only; elsewhere the builder is returned unchanged).
#[cfg(not(target_os = "macos"))]
pub fn with_app_menu<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder
}

#[cfg(target_os = "macos")]
fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let datatrip = SubmenuBuilder::new(app, "DataTrip")
        .item(&PredefinedMenuItem::about(
            app,
            Some("About DataTrip"),
            None,
        )?)
        .separator()
        .text("settings", "Settings…")
        .text("keyboardShortcuts", "Keyboard shortcuts…")
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some("Hide DataTrip"))?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Quit DataTrip"))?)
        .build()?;
    let file = SubmenuBuilder::new(app, "File")
        .text("newConnection", "New connection…")
        .text("newConsole", "New console")
        .text("newCrossSource", "New cross-source console")
        .separator()
        .text("openFile", "Open SQL file…")
        .text("saveFile", "Save")
        .text("saveFileAs", "Save as…")
        .text("exportSelection", "Export selection as .sql…")
        .text("runSqlFile", "Run SQL file on a data source…")
        .separator()
        .text("importDataGrip", "Import from DataGrip…")
        .text("vaultProfiles", "Vault profiles…")
        .text("sshProfiles", "SSH configurations…")
        .separator()
        .text("reopenTab", "Reopen closed tab")
        .text("closeTab", "Close tab")
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .text("tabsTop", "Tabs on top")
        .text("tabsLeft", "Tabs on the left")
        .text("tabsRight", "Tabs on the right")
        .separator()
        .text("toggleSidebar", "Show / hide sidebar")
        .text("compactExplorer", "Compact explorer")
        .separator()
        .text("queryHistory", "Query history")
        .text("commandPalette", "Command palette…")
        .build()?;
    let console = SubmenuBuilder::new(app, "Console")
        .text("runStatement", "Run statement")
        .text("runAll", "Run all")
        .text("cancel", "Cancel query")
        .separator()
        .text("formatSql", "Format SQL")
        .text("askAi", "Ask AI…")
        .separator()
        .text("attachSource", "Attach source…")
        .separator()
        .text("reconnect", "Reconnect data source")
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, Some("Zoom"))?)
        .separator()
        .text("nextTab", "Next tab")
        .text("prevTab", "Previous tab")
        .text("jumpToTab", "Jump to tab…")
        .build()?;
    let help = SubmenuBuilder::new(app, "Help")
        .text("help", "DataTrip help")
        .text("welcomeTour", "Welcome tour")
        .separator()
        .text("helpShortcuts", "Keyboard shortcuts…")
        .text("crossSourceGuide", "Cross-source queries guide")
        .text("helpPalette", "Command palette…")
        .separator()
        .text("checkUpdates", "Check for updates…")
        .build()?;
    MenuBuilder::new(app)
        .items(&[&datatrip, &file, &edit, &view, &console, &window, &help])
        .build()
}
