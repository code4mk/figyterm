import { Fragment, useEffect, useRef, useState } from "react";
import { Dialog, Transition } from "@headlessui/react";
import { AppWindow } from "lucide-react";

/**
 * Asks what to call a window, on the way to opening it.
 *
 * A window is the thing you alt-tab to, and with three of them open the only
 * way to tell which is which is what they are called. Naming it at the moment
 * you make it is the one moment you know what it is *for* — "the deploy one",
 * "api" — and a name given then is worth more than any title the app could
 * derive from a working directory five minutes later.
 *
 * **Empty is a real answer**, and the common one. Enter on an untouched field
 * hands the naming to the backend, which picks a fruit nothing else is called;
 * so the cost of a named window is one keystroke, and skipping it still leaves
 * you with `Mango` rather than a third identical `FigyTerm`.
 *
 * Styled as the tab rename prompt is, because it is the same gesture one level
 * up and arriving at a different-looking box for it would be the surprise.
 */

interface NewWindowPromptProps {
  open: boolean;
  onCancel: () => void;
  /** The trimmed name, or an empty string for "you pick". */
  onSubmit: (name: string) => void;
}

export function NewWindowPrompt({ open, onCancel, onSubmit }: NewWindowPromptProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Cleared on each open rather than on close: the field is read while the
  // dialog animates out, and resetting it there blanks the name mid-flight.
  useEffect(() => {
    if (!open) return;
    setValue("");
    const timer = setTimeout(() => inputRef.current?.focus(), 200);
    return () => clearTimeout(timer);
  }, [open]);

  const submit = () => {
    onSubmit(value.trim());
    setValue("");
  };

  return (
    <Transition appear show={open} as={Fragment}>
      <Dialog as="div" className="relative z-[300]" onClose={onCancel}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-150"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-100"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-sm"
            onMouseDown={(e) => e.stopPropagation()}
            onMouseUp={(e) => e.stopPropagation()}
          />
        </Transition.Child>

        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-150"
            enterFrom="opacity-0 scale-95"
            enterTo="opacity-100 scale-100"
            leave="ease-in duration-100"
            leaveFrom="opacity-100 scale-100"
            leaveTo="opacity-0 scale-95"
          >
            <Dialog.Panel
              className="w-full max-w-sm rounded-xl settings-modal shadow-2xl p-5"
              onMouseDown={(e) => e.stopPropagation()}
              onMouseUp={(e) => e.stopPropagation()}
            >
              <Dialog.Title className="flex items-center gap-2 text-sm font-semibold text-ft-text mb-1">
                <AppWindow size={14} className="text-ft-accent shrink-0" />
                New Window
              </Dialog.Title>
              <p className="text-xs text-ft-text-secondary mb-3">
                What should this window be called? It shows in the title bar and when
                you switch windows.
              </p>

              <input
                ref={inputRef}
                type="text"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  // Stopped here, as the tab rename does: the app's own chords
                  // are listening on the window and would fire on what is being
                  // typed into the field.
                  e.stopPropagation();
                  if (e.key === "Enter") submit();
                  if (e.key === "Escape") onCancel();
                }}
                onKeyUp={(e) => e.stopPropagation()}
                onPaste={(e) => e.stopPropagation()}
                placeholder="Leave empty for a name of its own"
                className="settings-input w-full rounded-lg px-3 py-2 text-sm"
                autoFocus
              />

              <div className="flex items-center justify-end gap-2 mt-4">
                <button
                  onClick={onCancel}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-ft-text-secondary hover:text-ft-text hover:bg-ft-surface transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={submit}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-ft-accent text-white hover:bg-ft-accent-hover transition-colors"
                >
                  Open
                </button>
              </div>
            </Dialog.Panel>
          </Transition.Child>
        </div>
      </Dialog>
    </Transition>
  );
}
