import React, {
    FunctionComponent, useEffect, useState, useRef,
    forwardRef, useImperativeHandle, RefForwardingComponent, SyntheticEvent
} from 'react'
import Immutable from 'immutable'
import classNames from 'classnames'
import { createStyles, withStyles, WithStyles, Theme } from '@material-ui/core/styles'
import Paper from '@material-ui/core/Paper'
import {
    Editor, EditorState, convertFromRaw, RichUtils, AtomicBlockUtils,
    CompositeDecorator, convertToRaw, DefaultDraftBlockRenderMap, DraftEditorCommand,
    DraftHandleValue, DraftStyleMap, ContentBlock, DraftDecorator,
    SelectionState, KeyBindingUtil, getDefaultKeyBinding, Modifier
} from 'draft-js'

import Toolbar, { TToolbarControl, TCustomControl, TToolbarButtonSize } from './components/Toolbar'
import Link from './components/Link'
import Media from './components/Media'
import Blockquote from './components/Blockquote'
import CodeBlock from './components/CodeBlock'
import UrlPopover, { TAlignment, TUrlData, TMediaType } from './components/UrlPopover'
import Autocomplete, { TAutocompleteItem } from './components/Autocomplete'
import { getSelectionInfo, removeBlockFromMap, atomicBlockExists, isGreaterThan, clearInlineStyles, getEditorBounds, getLineNumber } from './utils'

export type TDecorator = {
    component: FunctionComponent
    regex: RegExp
}

export type TAutocompleteStrategy = {
    triggerChar: string
    items: TAutocompleteItem[]
    insertSpaceAfter?: boolean
    atomicBlockName?: string
    minSearchChars?: number
    maxWidth?: number
    maxHeight?: number
    handleAutoComplete?: (editorState: EditorState, selectionState: SelectionState, value: any) => EditorState
}

export type TAutocomplete = {
    strategies: TAutocompleteStrategy[]
    suggestLimit?: number
}

export type TAsyncAtomicBlockResponse = {
    data: any
}

export type TMUIRichTextEditorRef = {
    focus: () => void
    save: () => void
    /**
     * @deprecated Use `insertAtomicBlockSync` instead.
     */
    insertAtomicBlock: (name: string, data: any) => void
    insertAtomicBlockSync: (name: string, data: any) => void
    insertAtomicBlockAsync: (name: string, promise: Promise<TAsyncAtomicBlockResponse>, placeholder?: string) => void
}

export type TDraftEditorProps = {
    spellCheck?: boolean
    stripPastedStyles?: boolean
    handleDroppedFiles?: (selectionState: SelectionState, files: Blob[]) => DraftHandleValue
}

export type TKeyCommand = {
    key: number
    name: string
    callback: (state: EditorState) => EditorState
}

export type TMUIRichTextEditorProps = {
    id?: string
    /**
     * @deprecated Use `defaultValue` instead.
     */
    value?: any
    defaultValue?: any
    label?: string
    readOnly?: boolean
    inheritFontSize?: boolean
    error?: boolean
    controls?: Array<TToolbarControl>
    customControls?: TCustomControl[]
    decorators?: TDecorator[]
    toolbar?: boolean
    toolbarButtonSize?: TToolbarButtonSize
    inlineToolbar?: boolean
    inlineToolbarControls?: Array<TToolbarControl>
    draftEditorProps?: TDraftEditorProps
    keyCommands?: TKeyCommand[]
    maxLength?: number
    autocomplete?: TAutocomplete
    onSave?: (data: string) => void
    onChange?: (state: EditorState) => void
    onFocus?: () => void
    onBlur?: () => void
}

interface IMUIRichTextEditorProps extends TMUIRichTextEditorProps, WithStyles<typeof styles> { }

type TMUIRichTextEditorState = {
    anchorUrlPopover?: HTMLElement
    urlKey?: string
    urlData?: TUrlData
    urlIsMedia?: boolean
    toolbarPosition?: TPosition
}

type TStateOffset = {
    start: number
    end: number
}

type TPosition = {
    top: number | 'unset'
    bottom: number | 'unset'
    left: number | 'unset'
    right: number | 'unset'
}

type TCustomRenderers = {
    style?: DraftStyleMap
    block?: Immutable.Map<any, any>
}

const styles = ({ spacing, typography, palette }: Theme) => createStyles({
    root: {
    },
    autocomplete: {
    },
    container: {
        margin: spacing(1, 0, 0, 0),
        position: "relative",
        fontFamily: typography.body1.fontFamily,
        fontSize: typography.body1.fontSize,
        '& figure': {
            margin: 0
        }
    },
    inheritFontSize: {
        fontSize: "inherit"
    },
    editor: {
    },
    editorContainer: {
        margin: spacing(1, 0, 0, 0),
        cursor: "text",
        width: "100%",
        padding: spacing(0, 0, 1, 0)
    },
    editorReadOnly: {
        borderBottom: "none"
    },
    error: {
        borderBottom: "2px solid red"
    },
    hidePlaceholder: {
        display: "none"
    },
    placeHolder: {
        color: palette.grey[600],
        position: "absolute"
    },
    linkPopover: {
        padding: spacing(2, 2, 2, 2)
    },
    linkTextField: {
        width: "100%"
    },
    anchorLink: {
    },
    toolbar: {
    },
    inlineToolbar: {
        maxWidth: "180px",
        position: "absolute",
        padding: "5px",
        zIndex: 10
    }
})

const blockRenderMap = Immutable.Map({
    'blockquote': {
        element: "blockquote",
        wrapper: <Blockquote />
    },
    'code-block': {
        element: "pre",
        wrapper: <CodeBlock />
    }
})
const styleRenderMap: DraftStyleMap = {
    'STRIKETHROUGH': {
        textDecoration: "line-through"
    },
    'HIGHLIGHT': {
        backgroundColor: "yellow"
    }
}

const { hasCommandModifier } = KeyBindingUtil
const defaultAutocompleteMinSearchCharCount = 2
const defaultAutocompleteMaxWidth = 200;
const defaultAutocompleteMaxHeight = 200;

const lineHeight = 26
const defaultInlineToolbarControls = ["bold", "italic", "underline", "clear"]

const findLinkEntities = (contentBlock: any, callback: any, contentState: any) => {
    contentBlock.findEntityRanges(
        (character: any) => {
            const entityKey = character.getEntity()
            return (
                entityKey !== null &&
                contentState.getEntity(entityKey).getType() === 'LINK'
            )
        },
        callback
    )
}

const findDecoWithRegex = (regex: RegExp, contentBlock: any, callback: any) => {
    const text = contentBlock.getText()
    let matchArr, start
    while ((matchArr = regex.exec(text)) !== null) {
        start = matchArr.index
        callback(start, start + matchArr[0].length)
    }
}

const useEditorState = (props: IMUIRichTextEditorProps) => {
    const decorators: DraftDecorator[] = [
        {
            strategy: findLinkEntities,
            component: Link,
        }
    ]
    if (props.decorators) {
        props.decorators.forEach(deco => decorators.push({
            strategy: (contentBlock: any, callback: any) => {
                findDecoWithRegex(deco.regex, contentBlock, callback)
            },
            component: deco.component
        }))
    }
    const decorator = new CompositeDecorator(decorators)
    const defaultValue = props.defaultValue || props.value
    return (defaultValue)
        ? EditorState.createWithContent(convertFromRaw(JSON.parse(defaultValue)), decorator)
        : EditorState.createEmpty(decorator)
}

const MUIRichTextEditor: RefForwardingComponent<TMUIRichTextEditorRef, IMUIRichTextEditorProps> = (props, ref) => {
    const { classes, controls, customControls } = props

    const [state, setState] = useState<TMUIRichTextEditorState>({})
    const [focus, setFocus] = useState(false)
    const [searchTerm, setSearchTerm] = useState("")
    const [selectedIndex, setSelectedIndex] = useState<number>(0)
    const [editorState, setEditorState] = useState(() => useEditorState(props))
    const [focusMediaKey, setFocusMediaKey] = useState("")
    const [customRenderers, setCustomRenderers] = useState<TCustomRenderers>({
        style: undefined,
        block: undefined
    })
    const [showAutocompletePopup, setShowAutocompletePopup] = useState(false);

    const editorRef = useRef(null)
    const editorId = props.id || "mui-rte"
    const toolbarPositionRef = useRef<TPosition | undefined>(undefined)
    const editorStateRef = useRef<EditorState | null>(editorState)
    const autocompleteRef = useRef<TAutocompleteStrategy | undefined>(undefined)
    const autocompleteSelectionStateRef = useRef<SelectionState | undefined>(undefined)
    const autocompletePositionRef = useRef<TPosition | undefined>(undefined)
    const autocompleteLimit = props.autocomplete ? props.autocomplete.suggestLimit || 5 : 5
    const selectionRef = useRef<TStateOffset>({
        start: 0,
        end: 0
    })

    /**
     * Exposed methods
     */
    useImperativeHandle(ref, () => ({
        focus: () => {
            handleFocus()
        },
        save: () => {
            handleSave()
        },
        insertAtomicBlock: (name: string, data: any) => {
            handleInsertAtomicBlockSync(name, data)
        },
        insertAtomicBlockSync: (name: string, data: any) => {
            handleInsertAtomicBlockSync(name, data)
        },
        insertAtomicBlockAsync: (name: string, promise: Promise<TAsyncAtomicBlockResponse>, placeholder?: string) => {
            handleInsertAtomicBlockAsync(name, promise, placeholder)
        }
    }))

    useEffect(() => {
        const editorState = useEditorState(props)
        const customBlockMap: any = {}
        const customStyleMap = JSON.parse(JSON.stringify(styleRenderMap))
        if (props.customControls) {
            props.customControls.forEach(control => {
                if (control.type === "inline" && control.inlineStyle) {
                    customStyleMap[control.name.toUpperCase()] = control.inlineStyle
                }
                else if (control.type === "block" && control.blockWrapper) {
                    customBlockMap[control.name.toUpperCase()] = {
                        element: "div",
                        wrapper: control.blockWrapper
                    }
                }
            })
        }
        setCustomRenderers({
            style: customStyleMap,
            block: DefaultDraftBlockRenderMap.merge(blockRenderMap, Immutable.Map(customBlockMap))
        })
        const nextEditorState = EditorState.forceSelection(editorState, editorState.getSelection())
        if (props.readOnly === true) {
            setEditorState(nextEditorState)
        } else {
            setEditorState(EditorState.moveFocusToEnd(nextEditorState))
        }
        toggleMouseUpListener(true)
        return () => {
            toggleMouseUpListener()
        }
    }, [props.value, props.defaultValue])

    useEffect(() => {
        if (props.onChange) {
            props.onChange(editorState)
        }
        editorStateRef.current = editorState
    }, [editorState])

    useEffect(() => {
        toolbarPositionRef.current = state.toolbarPosition
    }, [state.toolbarPosition])

    useEffect(() => {
        if (searchTerm.length < autocompleteMinSearchCharCount()) {
            setSelectedIndex(0)
        }
    }, [searchTerm])

    const autocompleteMinSearchCharCount = () => autocompleteRef.current?.minSearchChars ?? defaultAutocompleteMinSearchCharCount
    const canShowAutocompletePopup = () => autocompleteMinSearchCharCount() <= searchTerm.length + 1 && getAutocompleteItems().length > 0

    const clearSearch = () => {
        setSearchTerm("")
        autocompleteRef.current = undefined
        autocompletePositionRef.current = undefined
        autocompleteSelectionStateRef.current = undefined
        setShowAutocompletePopup(false)
    }

    const handleMouseUp = (event: any) => {
        const nodeName = event.target.nodeName
        clearSearch()
        if (nodeName === "IMG" || nodeName === "VIDEO") {
            return
        }
        setTimeout(() => {
            const selection = editorStateRef.current!.getSelection()
            if (selection.isCollapsed() || (toolbarPositionRef !== undefined &&
                selectionRef.current.start === selection.getStartOffset() &&
                selectionRef.current.end === selection.getEndOffset())) {
                const selectionInfo = getSelectionInfo(editorStateRef.current!)
                if (selectionInfo.entityType === "IMAGE") {
                    focusMedia(selectionInfo.block)
                    return
                }
                setState({
                    ...state,
                    toolbarPosition: undefined
                })
                return
            }

            selectionRef.current = {
                start: selection.getStartOffset(),
                end: selection.getEndOffset()
            }

            const editor: HTMLElement = (editorRef.current as any).editor
            const { editorRect, selectionRect } = getEditorBounds(editor)
            if (!selectionRect) {
                return
            }
            const position: TPosition = {
                top: editor.offsetTop - 48 + (selectionRect.top - editorRect.top),
                left: editor.offsetLeft + (selectionRect.left - editorRect.left),
                bottom: "unset",
                right: "unset",
            }
            setState({
                ...state,
                toolbarPosition: position
            })
        }, 1)
    }

    const findAutocompleteStrategy = (chars: string): TAutocompleteStrategy | undefined => {
        if (!props.autocomplete) {
            return undefined
        }
        const acArray = props.autocomplete.strategies.filter(ac => ac.triggerChar === chars)
        if (acArray.length) {
            return acArray[0]
        }
        return undefined
    }

    const updateAutocompletePosition = () => {
        if (!autocompleteSelectionStateRef.current) {
            autocompleteSelectionStateRef.current = editorStateRef.current!.getSelection()
        }
        const editor: HTMLElement = (editorRef.current as any).editor
        const { editorRect, selectionRect } = getEditorBounds(editor)
        const line = getLineNumber(editorState)
        const top = selectionRect ? selectionRect.top : editorRect.top + (lineHeight * line)
        const left = selectionRect ? selectionRect.left : editorRect.left
        const width = autocompleteRef.current?.maxWidth ?? defaultAutocompleteMaxWidth;
        const height = autocompleteRef.current?.maxHeight ?? defaultAutocompleteMaxHeight;

        const position: TPosition = {
            top: 'unset',
            left: 'unset',
            bottom: 'unset',
            right: 'unset',
        };
        if (top + height <= window.innerHeight) {
            position.top = editor.offsetTop + (top - editorRect.top) + lineHeight;
        } else {
            position.bottom = editorRect.bottom - top + lineHeight / 2;
        }
        if (left + width < window.innerWidth) {
            position.left = editor.offsetLeft + (left - editorRect.left);
        } else {
            position.right = 0;
        }
        autocompletePositionRef.current = position
    }

    const insertAutocompleteSuggestionAsAtomicBlock = (name: string, selection: SelectionState, value: any) => {
        const block = atomicBlockExists(name, props.customControls)
        if (!block) {
            return
        }
        const contentState = Modifier.removeRange(editorStateRef.current!.getCurrentContent(),
            selection,
            "forward")
        const newEditorState = EditorState.push(editorStateRef.current!, contentState, "remove-range")
        const withAtomicBlock = insertAtomicBlock(newEditorState, name.toUpperCase(), {
            value: value
        }, {
            selection: newEditorState.getCurrentContent().getSelectionAfter()
        })
        handleChange(withAtomicBlock)
    }

    const insertAutocompleteSuggestionAsText = (selection: SelectionState, value: string) => {
        const currentContentState = editorState.getCurrentContent()
        const entityKey = currentContentState.createEntity("AC_ITEM", 'IMMUTABLE').getLastCreatedEntityKey()
        const contentState = Modifier.replaceText(editorStateRef.current!.getCurrentContent(),
            selection,
            value,
            editorStateRef.current!.getCurrentInlineStyle(),
            entityKey)
        const newEditorState = EditorState.push(editorStateRef.current!, contentState, "insert-characters")
        if (autocompleteRef.current!.insertSpaceAfter === false) {
            handleChange(newEditorState)
        } else {
            const addSpaceState = Modifier.insertText(newEditorState.getCurrentContent(),
                newEditorState.getSelection(), " ",
                newEditorState.getCurrentInlineStyle())
            handleChange(EditorState.push(newEditorState, addSpaceState, "insert-characters"))
        }
    }

    const handleAutocompleteSelected = (index?: number) => {
        const itemIndex = index || selectedIndex
        const items = getAutocompleteItems()
        if (items.length > itemIndex) {
            const item = items[itemIndex]
            const currentSelection = autocompleteSelectionStateRef.current!
            const offset = currentSelection.getFocusOffset() + searchTerm.length + 1
            const newSelection = currentSelection.merge({
                'focusOffset': offset
            })

            const autoCompleteStrategy = autocompleteRef.current!
            if (autoCompleteStrategy.handleAutoComplete) {
                const newState = autoCompleteStrategy.handleAutoComplete(editorState, newSelection as SelectionState, item.value)
                handleChange(newState)
            } else if (autoCompleteStrategy.atomicBlockName) {
                const name = autoCompleteStrategy.atomicBlockName
                insertAutocompleteSuggestionAsAtomicBlock(name, newSelection as SelectionState, item.value)
            } else {
                insertAutocompleteSuggestionAsText(newSelection as SelectionState, item.value)
            }
        }
        handleAutocompleteClosed()
    }

    const handleAutocompleteClosed = () => {
        clearSearch()
        setSelectedIndex(0)
    }

    const getAutocompleteItems = (): TAutocompleteItem[] => {
        return autocompleteRef.current!.items
            .filter(item => (item.keys.filter(key => key.includes(searchTerm)).length > 0))
            .splice(0, autocompleteLimit)
    }

    const handleChange = (state: EditorState) => {
        setEditorState(state)
    }

    const handleBeforeInput = (chars: string): DraftHandleValue => {
        if (chars === " " && autocompleteRef.current?.items?.length == 1) {
            if (0 <= autocompleteRef.current?.items[0].keys.findIndex(k => k === searchTerm)) {
                handleAutocompleteSelected()
                return "handled"
            } else {
                clearSearch();
            }
        } else if (autocompleteSelectionStateRef.current) {
            setSearchTerm(searchTerm + chars)
            if (canShowAutocompletePopup()) {
                setShowAutocompletePopup(true);
            } else {
                setShowAutocompletePopup(false);
            }
        } else {
            const strategy = findAutocompleteStrategy(chars)
            if (strategy) {
                autocompleteRef.current = strategy
                updateAutocompletePosition()
            }
        }

        const currentLength = editorState.getCurrentContent().getPlainText('').length
        return isGreaterThan(currentLength + 1, props.maxLength) ? "handled" : "not-handled"
    }

    const handleFocus = () => {
        setFocus(true)
        setTimeout(() => (editorRef.current as any).focus(), 0)
        if (props.onFocus) {
            props.onFocus()
        }
    }

    const handleBlur = () => {
        setFocus(false)
        if (props.onBlur) {
            props.onBlur()
        }

        if (!state.anchorUrlPopover) {
            setState({
                ...state,
                toolbarPosition: undefined
            })
        }
    }

    const handleClearFormat = () => {
        const withoutStyles = clearInlineStyles(editorState, customRenderers.style)
        const selectionInfo = getSelectionInfo(editorState)
        const newEditorState = EditorState.push(editorState, withoutStyles, 'change-inline-style')
        setEditorState(RichUtils.toggleBlockType(newEditorState, selectionInfo.blockType))
    }

    const handleSave = () => {
        if (props.onSave) {
            props.onSave(JSON.stringify(convertToRaw(editorState.getCurrentContent())))
        }
    }

    const handleInsertAtomicBlockSync = (name: string, data: any) => {
        const block = atomicBlockExists(name, props.customControls)
        if (!block) {
            return
        }
        const newEditorState = insertAtomicBlock(editorState, block.name.toUpperCase(), data, {
            selection: editorState.getCurrentContent().getSelectionAfter()
        })
        updateStateForPopover(newEditorState)
    }

    const handleInsertAtomicBlockAsync = (name: string, promise: Promise<TAsyncAtomicBlockResponse>, placeholder?: string) => {
        const selection = insertAsyncAtomicBlockPlaceholder(name, placeholder)
        const offset = selection.getFocusOffset() + 1
        const newSelection = selection.merge({
            'focusOffset': offset
        })

        promise.then(response => {
            const newEditorState = insertAtomicBlock(editorStateRef.current!, name, response.data, {
                selection: newSelection
            })
            handleChange(newEditorState)
        }).catch(error => {
            if (error) {
                return
            }
            const newContentState = Modifier.removeRange(editorStateRef.current!.getCurrentContent(),
                newSelection as SelectionState, "forward")
            handleChange(EditorState.push(editorStateRef.current!, newContentState, "remove-range"))
        })
    }

    const insertAsyncAtomicBlockPlaceholder = (name: string, placeholder?: string): SelectionState => {
        const placeholderName = placeholder || name + "..."
        const currentContentState = editorStateRef.current!.getCurrentContent()
        const entityKey = currentContentState.createEntity("ASYNC_ATOMICBLOCK", 'IMMUTABLE').getLastCreatedEntityKey()
        const contentState = Modifier.insertText(editorStateRef.current!.getCurrentContent(),
            currentContentState.getSelectionAfter(),
            placeholderName,
            undefined,
            entityKey)

        const selection = currentContentState.getSelectionAfter()
        const newEditorState = EditorState.push(editorStateRef.current!, contentState, "insert-characters")
        handleChange(newEditorState)
        return selection
    }

    const handleKeyCommand = (command: DraftEditorCommand | string, editorState: EditorState): DraftHandleValue => {
        const newState = RichUtils.handleKeyCommand(editorState, command)
        if (newState) {
            handleChange(newState)
            return "handled"
        }
        else {
            if (command.includes("mui-autocomplete")) {
                if (command === "mui-autocomplete-insert") {
                    handleAutocompleteSelected()
                }
                if (command === "mui-autocomplete-end") {
                    handleAutocompleteClosed()
                }
                return "handled"
            }
            if (props.keyCommands) {
                const keyCommand = props.keyCommands.find(comm => comm.name === command)
                if (keyCommand) {
                    const newState = keyCommand.callback(editorState)
                    handleChange(newState)
                    return "handled"
                }
            }
        }
        return "not-handled"
    }

    const handleCustomClick = (style: any, id: string) => {
        if (!props.customControls) {
            return
        }
        for (let control of props.customControls) {
            if (control.name.toUpperCase() === style) {
                if (control.onClick) {
                    setTimeout(() => (editorRef.current as any).blur(), 0)
                    const newState = control.onClick(editorState, control.name, document.getElementById(id))
                    if (newState) {
                        if (newState.getSelection().isCollapsed()) {
                            setEditorState(newState)
                        }
                        else {
                            updateStateForPopover(newState)
                        }
                    }
                    else {
                        if (!editorState.getSelection().isCollapsed()) {
                            refocus()
                        }
                    }
                }
                break
            }
        }
    }

    const handleUndo = () => {
        setEditorState(EditorState.undo(editorState))
    }

    const handleRedo = () => {
        setEditorState(EditorState.redo(editorState))
    }

    const handlePrompt = (lastState: EditorState, type: "link" | "media", inlineMode?: boolean) => {
        const selectionInfo = getSelectionInfo(lastState)
        const contentState = lastState.getCurrentContent()
        const linkKey = selectionInfo.linkKey
        let data = undefined
        if (linkKey) {
            const linkInstance = contentState.getEntity(linkKey)
            data = linkInstance.getData()
        }
        setState({
            urlData: data,
            urlKey: linkKey,
            toolbarPosition: !inlineMode ? undefined : state.toolbarPosition,
            anchorUrlPopover: !inlineMode ? document.getElementById(`${editorId}-${type}-control-button`)!
                : document.getElementById(`${editorId}-${type}-control-button-toolbar`)!,
            urlIsMedia: type === "media" ? true : undefined
        })
    }

    const handlePromptForLink = (inlineMode?: boolean) => {
        const selection = editorState.getSelection()

        if (!selection.isCollapsed()) {
            handlePrompt(editorState, "link", inlineMode)
        }
    }

    const handlePromptForMedia = (inlineMode?: boolean, newState?: EditorState) => {
        const lastState = newState || editorState
        handlePrompt(lastState, "media", inlineMode)
    }

    const handleConfirmPrompt = (isMedia?: boolean, ...args: any) => {
        if (isMedia) {
            confirmMedia(...args)
            return
        }
        confirmLink(...args)
    }

    const handleToolbarClick = (style: string, type: string, id: string, inlineMode?: boolean) => {
        if (type === "inline") {
            return toggleInlineStyle(style)
        }
        if (type === "block") {
            return toggleBlockType(style)
        }
        switch (style) {
            case "UNDO":
                handleUndo()
                break
            case "REDO":
                handleRedo()
                break
            case "LINK":
                handlePromptForLink(inlineMode)
                break
            case "IMAGE":
                handlePromptForMedia(inlineMode)
                break
            case "clear":
                handleClearFormat()
                break
            case "save":
                handleSave()
                break
            default:
                handleCustomClick(style, id)
        }
    }

    const handlePastedText = (text: string, _html: string | undefined, editorState: EditorState): DraftHandleValue => {
        const currentLength = editorState.getCurrentContent().getPlainText('').length
        return isGreaterThan(currentLength + text.length, props.maxLength) ? "handled" : "not-handled"
    }

    const handleOnTab = (ev: React.KeyboardEvent<{}>) => {
        const blockType = RichUtils.getCurrentBlockType(editorState);
        let newEditorState = RichUtils.onTab(ev, editorState, 4)
        //newEditorState = RichUtils.toggleBlockType(newEditorState, blockType)
        handleChange(newEditorState);
    }

    const toggleMouseUpListener = (addAfter = false) => {
        const editor: HTMLElement = (editorRef.current as any).editor
        if (!editor) {
            return
        }
        editor.removeEventListener("mouseup", handleMouseUp)
        if (addAfter) {
            editor.addEventListener("mouseup", handleMouseUp)
        }
    }

    const removeLink = () => {
        const selection = editorState.getSelection()
        setEditorState(RichUtils.toggleLink(editorState, selection, null))
    }

    const confirmLink = (url?: string) => {
        const { urlKey } = state
        if (!url) {
            if (urlKey) {
                removeLink()
            }
            dismissPopover()
            return
        }

        const contentState = editorState.getCurrentContent()
        let replaceEditorState = editorState
        const data = {
            url: url,
            className: classes.anchorLink
        }

        if (urlKey) {
            contentState.replaceEntityData(urlKey, data)
            replaceEditorState = EditorState.push(editorState, contentState, "apply-entity")
        }
        else {
            const contentStateWithEntity = contentState.createEntity('LINK', 'MUTABLE', data)
            const entityKey = contentStateWithEntity.getLastCreatedEntityKey()
            const newEditorState = EditorState.set(editorState, { currentContent: contentStateWithEntity })
            replaceEditorState = RichUtils.toggleLink(
                newEditorState,
                newEditorState.getSelection(),
                entityKey)
        }
        updateStateForPopover(replaceEditorState)
    }

    const removeMedia = () => {
        const blockKey = editorState.getSelection().getStartKey()
        const contentState = editorState.getCurrentContent()
        const mediaBlock = contentState.getBlockForKey(blockKey)
        const newContentState = removeBlockFromMap(editorState, mediaBlock)
        const newEditorState = EditorState.push(editorState, newContentState, "remove-range")
        setEditorState(newEditorState)
    }

    const confirmMedia = (url?: string, width?: number, height?: number, alignment?: TAlignment, type?: TMediaType) => {
        const { urlKey } = state
        if (!url) {
            if (urlKey) {
                removeMedia()
            }
            dismissPopover()
            return
        }

        const contentState = editorState.getCurrentContent()
        const data = {
            url: url,
            width: width,
            height: height,
            alignment: alignment,
            type: type
        }

        if (urlKey) {
            contentState.replaceEntityData(urlKey, data)
            const newEditorState = EditorState.push(editorState, contentState, "apply-entity")
            updateStateForPopover(EditorState.forceSelection(newEditorState, newEditorState.getCurrentContent().getSelectionAfter()))
        }
        else {
            const newEditorState = insertAtomicBlock(editorState, "IMAGE", data)
            updateStateForPopover(EditorState.forceSelection(newEditorState, newEditorState.getCurrentContent().getSelectionAfter()))
        }
        setFocusMediaKey("")
    }

    const updateStateForPopover = (editorState: EditorState) => {
        setEditorState(editorState)
        dismissPopover()
    }

    const dismissPopover = () => {
        refocus()
        setState({
            ...state,
            anchorUrlPopover: undefined,
            urlKey: undefined,
            urlIsMedia: undefined,
            urlData: undefined
        })
    }

    const refocus = () => {
        setTimeout(() => (editorRef.current as any).blur(), 0)
        setTimeout(() => (editorRef.current as any).focus(), 1)
    }

    const toggleBlockType = (blockType: string) => {
        setEditorState(
            RichUtils.toggleBlockType(
                editorState,
                blockType
            )
        )
    }

    const toggleInlineStyle = (inlineStyle: string) => {
        setEditorState(
            RichUtils.toggleInlineStyle(
                editorState,
                inlineStyle
            )
        )
    }

    const focusMedia = (block: ContentBlock) => {
        const newSeletion = SelectionState.createEmpty(block.getKey())
        const newEditorState = EditorState.forceSelection(editorStateRef.current!, newSeletion)
        editorStateRef.current = newEditorState
        setFocusMediaKey(block.getKey())
        setEditorState(newEditorState)
        handlePromptForMedia(false, newEditorState)
    }

    const blockRenderer = (contentBlock: ContentBlock) => {
        const blockType = contentBlock.getType()
        if (blockType === 'atomic') {
            const contentState = editorState.getCurrentContent()
            const entity = contentBlock.getEntityAt(0)
            if (entity) {
                const type = contentState.getEntity(entity).getType()
                if (type === "IMAGE") {
                    return {
                        component: Media,
                        editable: false,
                        props: {
                            onClick: focusMedia,
                            readOnly: props.readOnly,
                            focusKey: focusMediaKey
                        }
                    }
                } else {
                    const block = atomicBlockExists(type.toLowerCase(), props.customControls)
                    if (!block) {
                        return null
                    }
                    return {
                        component: block.atomicComponent,
                        editable: false,
                        props: contentState.getEntity(contentBlock.getEntityAt(0)).getData()
                    }
                }
            }
        }
        return null
    }

    const insertAtomicBlock = (editorState: EditorState, type: string, data: any, options?: any) => {
        const contentState = editorState.getCurrentContent()
        const contentStateWithEntity = contentState.createEntity(type, 'IMMUTABLE', data)
        const entityKey = contentStateWithEntity.getLastCreatedEntityKey()
        const newEditorStateRaw = EditorState.set(editorState, {
            currentContent: contentStateWithEntity,
            ...options
        })
        return AtomicBlockUtils.insertAtomicBlock(newEditorStateRaw, entityKey, ' ')
    }

    const getAutocompleteKeyEvent = (keyboardEvent: React.KeyboardEvent<{}>): string | null => {
        const itemsLength = getAutocompleteItems().length
        const limit = autocompleteLimit > itemsLength ? itemsLength : autocompleteLimit
        switch (keyboardEvent.key) {
            case "ArrowDown":
                if ((selectedIndex === 0 && itemsLength === 1) || (selectedIndex + 1 === limit)) {
                    setSelectedIndex(0)
                } else {
                    setSelectedIndex(selectedIndex + 1 < limit ? selectedIndex + 1 : selectedIndex)
                }
                return "mui-autocomplete-navigate"
            case "ArrowUp":
                if (selectedIndex) {
                    setSelectedIndex(selectedIndex - 1)
                } else {
                    setSelectedIndex(limit - 1)
                }
                return "mui-autocomplete-navigate"
            case "Enter":
                return "mui-autocomplete-insert"
            case "Escape":
                return "mui-autocomplete-end"
            default:
                return null
        }
    }

    const updateSearchTermForKeyBinding = (keyBinding: DraftEditorCommand | null) => {
        const text = editorStateRef.current!.getCurrentContent().getLastBlock().getText()

        if (keyBinding === "backspace"
            && autocompleteRef.current
            && text.substr(text.length - 1) === autocompleteRef.current.triggerChar) {
            clearSearch()
        } else if (autocompletePositionRef.current
            && keyBinding === "backspace"
            && searchTerm.length) {
            setSearchTerm(searchTerm.substr(0, searchTerm.length - 1))
            if (canShowAutocompletePopup()) {
                setShowAutocompletePopup(true);
            } else {
                setShowAutocompletePopup(false);
            }
        } else if (!autocompletePositionRef.current &&
            (keyBinding === "backspace"
                || keyBinding === "split-block")) {
            clearSearch()
        }
    }

    const keyBindingFn = (e: React.KeyboardEvent<{}>): string | null => {
        if (hasCommandModifier(e) && props.keyCommands) {
            const comm = props.keyCommands.find(comm => comm.key === e.keyCode)
            if (comm) {
                return comm.name
            }
        }
        if (searchTerm) {
            const autocompleteEvent = getAutocompleteKeyEvent(e)
            if (autocompleteEvent) {
                return autocompleteEvent
            }
        }
        const keyBinding = getDefaultKeyBinding(e)
        updateSearchTermForKeyBinding(keyBinding)

        return keyBinding
    }

    const renderToolbar = props.toolbar === undefined || props.toolbar
    const inlineToolbarControls = props.inlineToolbarControls || defaultInlineToolbarControls
    const editable = props.readOnly === undefined || !props.readOnly
    let className = ""
    let placeholder: React.ReactElement | null = null
    if (!focus) {
        const contentState = editorState.getCurrentContent()
        if (!contentState.hasText()) {
            placeholder = (
                <div
                    className={classNames(classes.editorContainer, classes.placeHolder, {
                        [classes.error]: props.error
                    })}
                    onClick={handleFocus}
                >
                    {props.label || ""}
                </div>
            )
            className = classes.hidePlaceholder
        }
    }

    return (
        <div id={`${editorId}-root`} className={classes.root}>
            <div id={`${editorId}-container`} className={classNames(classes.container, {
                [classes.inheritFontSize]: props.inheritFontSize
            })}>
                {props.autocomplete && showAutocompletePopup && autocompletePositionRef.current ?
                    <Autocomplete
                        editorId={editorId}
                        classes={{ autocomplete: classes.autocomplete }}
                        items={getAutocompleteItems()}
                        top={autocompletePositionRef.current!.top}
                        bottom={autocompletePositionRef.current!.bottom}
                        left={autocompletePositionRef.current!.left}
                        right={autocompletePositionRef.current!.right}
                        onClick={handleAutocompleteSelected}
                        selectedIndex={selectedIndex}
                    />
                    : null}
                {props.inlineToolbar && editable && state.toolbarPosition ?
                    <Paper className={classes.inlineToolbar} style={{
                        top: state.toolbarPosition.top,
                        left: state.toolbarPosition.left
                    }}>
                        <Toolbar
                            id={editorId}
                            editorState={editorState}
                            onClick={handleToolbarClick}
                            controls={inlineToolbarControls}
                            customControls={customControls}
                            inlineMode={true}
                        />
                    </Paper>
                    : null}
                {renderToolbar ?
                    <Toolbar
                        id={editorId}
                        editorState={editorState}
                        onClick={handleToolbarClick}
                        controls={controls}
                        customControls={customControls}
                        className={classes.toolbar}
                        disabled={!editable}
                        size={props.toolbarButtonSize}
                    />
                    : null}
                {placeholder}
                <div id={`${editorId}-editor`} className={classes.editor}>
                    <div id={`${editorId}-editor-container`} className={classNames(className, classes.editorContainer, {
                        [classes.editorReadOnly]: !editable,
                        [classes.error]: props.error
                    })} onClick={handleFocus} onBlur={handleBlur}>
                        <Editor
                            customStyleMap={customRenderers.style}
                            blockRenderMap={customRenderers.block}
                            blockRendererFn={blockRenderer}
                            editorState={editorState}
                            onChange={handleChange}
                            onTab={handleOnTab}
                            readOnly={props.readOnly}
                            handleKeyCommand={handleKeyCommand}
                            handleBeforeInput={handleBeforeInput}
                            handlePastedText={handlePastedText}
                            keyBindingFn={keyBindingFn}
                            ref={editorRef}
                            {...props.draftEditorProps}
                        />
                    </div>
                </div>
                {state.anchorUrlPopover ?
                    <UrlPopover
                        data={state.urlData}
                        anchor={state.anchorUrlPopover}
                        onConfirm={handleConfirmPrompt}
                        isMedia={state.urlIsMedia}
                    />
                    : null}
            </div>
        </div>
    )
}

export default withStyles(styles, { withTheme: true, name: "MUIRichTextEditor" })(forwardRef(MUIRichTextEditor))
