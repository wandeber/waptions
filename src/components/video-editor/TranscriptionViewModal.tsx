'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/design-system/Button';
import { Subtitle } from '@/types/timeline';
import { Layers } from 'lucide-react';
import {
    DndContext,
    pointerWithin,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    DragOverlay,
    defaultDropAnimationSideEffects,
    DragStartEvent,
    DragOverEvent,
    DragEndEvent,
    DropAnimation,
    UniqueIdentifier,
    MeasuringStrategy,
    useDroppable,
    CollisionDetection,
} from '@dnd-kit/core';
import {
    SortableContext,
    sortableKeyboardCoordinates,
    horizontalListSortingStrategy,
    verticalListSortingStrategy,
    useSortable,
} from '@dnd-kit/sortable';
import { ConfirmDialog } from '@/components/design-system/ConfirmDialog';
import { CSS } from '@dnd-kit/utilities';
import { useTimelineStore } from '@/stores/timeline-store';

interface TranscriptionViewModalProps {
    isOpen: boolean;
    onClose: () => void;
    onApplyGroups: (groupedSubtitles: Subtitle[]) => void;
}

// --- Sortable Item (Word Badge) ---
function SortableWord({
    id,
    subtitle,
    isDraggable,
    isSelected,
    isEditing,
    onSelect,
    onEdit,
    onCommit,
    onCancel
}: {
    id: UniqueIdentifier;
    subtitle: Subtitle;
    isDraggable: boolean;
    isSelected: boolean;
    isEditing: boolean;
    onSelect: () => void;
    onEdit: () => void;
    onCommit: (text: string) => void;
    onCancel: () => void;
}) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({
        id,
        disabled: !isDraggable || isEditing
    });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
    };

    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isEditing && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isEditing]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
            onCommit(e.currentTarget.value);
        } else if (e.key === 'Escape') {
            onCancel();
        }
    };

    if (isDragging) {
        return (
            <div
                ref={setNodeRef}
                style={style}
                className="bg-purple-600 text-white px-3 py-1.5 rounded-full text-sm font-medium shadow-lg opacity-50 cursor-grabbing ring-2 ring-purple-400 ring-inset z-50"
            >
                {subtitle.text}
            </div>
        );
    }

    if (isEditing) {
        return (
            <div
                ref={setNodeRef}
                style={style}
                className="relative z-50"
            >
                <input
                    ref={inputRef}
                    defaultValue={subtitle.text}
                    className="bg-purple-900/90 text-white px-2 py-1 rounded text-sm border-2 border-purple-500 outline-none w-auto min-w-[60px] text-center shadow-lg"
                    onKeyDown={handleKeyDown}
                    onBlur={(e) => onCommit(e.currentTarget.value)}
                    onClick={(e) => e.stopPropagation()}
                />
            </div>
        );
    }

    return (
        <div
            ref={setNodeRef}
            style={style}
            {...attributes}
            {...listeners}
            tabIndex={0}
            onClick={(e) => {
                e.stopPropagation();
                onSelect();
            }}
            onDoubleClick={(e) => {
                e.stopPropagation();
                onEdit();
            }}
            onKeyDown={(e) => {
                if (isSelected && e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    onEdit();
                }
            }}
            className={`
                px-3 py-1.5 rounded-full text-sm flex items-center gap-2 select-none border transition-all duration-150
                ${isSelected
                    ? 'bg-purple-600 border-purple-400 text-white shadow-[0_0_15px_rgba(147,51,234,0.5)] scale-105 z-10'
                    : isDraggable
                        ? 'bg-gray-800 hover:bg-gray-700 text-gray-200 border-gray-700 hover:border-gray-500 cursor-grab active:cursor-grabbing'
                        : 'bg-gray-900 text-gray-500 border-gray-800 cursor-not-allowed opacity-60'
                }
            `}
        >
            <span>{subtitle.text}</span>
        </div>
    );
}

// --- Droppable Gap (Between Lines) ---
function DroppableGap({
    id,
    index,
    isExpanded,
    isInstant,
    onExpandChange
}: {
    id: UniqueIdentifier;
    index: number;
    isExpanded: boolean;
    isInstant?: boolean;
    onExpandChange: (expanded: boolean) => void;
}) {
    const { setNodeRef, isOver } = useDroppable({
        id,
        data: {
            type: 'Gap',
            index
        }
    });

    useEffect(() => {
        let timer: NodeJS.Timeout;
        if (isOver) {
            timer = setTimeout(() => {
                onExpandChange(true);
            }, 200);
        } else {
            // Hysteresis: wait 400ms before collapsing if it was expanded
            if (isExpanded) {
                timer = setTimeout(() => {
                    onExpandChange(false);
                }, 400);
            } else {
                onExpandChange(false);
            }
        }
        return () => clearTimeout(timer);
    }, [isOver, isExpanded, onExpandChange]);

    return (
        <div
            ref={setNodeRef}
            className={`w-full flex items-center justify-center ${isInstant ? '' : 'transition-all duration-300'}
                ${isExpanded ? 'h-[108px]' : 'h-6'}`}
        >
            <div
                className={`rounded-lg flex items-center justify-center w-full ${isInstant ? '' : 'transition-all duration-300'}
                    ${isExpanded
                        ? 'h-[60px] bg-purple-900/40 border-2 border-dashed border-purple-500/60 shadow-[0_0_20px_rgba(168,85,247,0.15)]'
                        : 'h-0 opacity-0 border-none overflow-hidden'
                    }`}
            >
                {isExpanded && (
                    <span className="text-purple-300 text-xs font-semibold animate-in zoom-in duration-300 tracking-wide uppercase">
                        Soltar para crear nueva línea
                    </span>
                )}
            </div>
        </div>
    );
}

// --- Droppable Container (Line) ---
function DroppableLine({
    id,
    items,
    selectedId,
    editingId,
    onSelect,
    onEdit,
    onCommit,
    onCancel,
    isRecentlyCreated
}: {
    id: UniqueIdentifier;
    items: Subtitle[];
    selectedId: UniqueIdentifier | null;
    editingId: UniqueIdentifier | null;
    onSelect: (id: UniqueIdentifier) => void;
    onEdit: (id: UniqueIdentifier) => void;
    onCommit: (id: string, text: string) => void;
    onCancel: () => void;
    isRecentlyCreated?: boolean;
}) {
    const { setNodeRef } = useSortable({
        id,
        data: {
            type: 'Line',
        }
    });

    return (
        <div
            ref={setNodeRef}
            className={`
                rounded-lg p-3 min-h-[60px] flex flex-wrap gap-2 items-center transition-all duration-500
                ${isRecentlyCreated
                    ? 'animate-[new-group-morph_0.8s_ease-out] border-2 z-10'
                    : 'bg-gray-950/50 border border-gray-800 hover:border-gray-700'
                }
            `}
            onClick={(e) => {
                e.stopPropagation();
                onCancel();
            }}
        >
            <div className="mr-2 text-xs text-gray-600 font-mono w-6 flex-shrink-0 select-none">
                {items.length}w
            </div>

            <SortableContext
                id={id as string}
                items={items.map(s => s.id)}
                strategy={horizontalListSortingStrategy}
            >
                {items.map((subtitle, index) => {
                    const isFirst = index === 0;
                    const isLast = index === items.length - 1;
                    const isDraggable = isFirst || isLast;

                    return (
                        <SortableWord
                            key={subtitle.id}
                            id={subtitle.id}
                            subtitle={subtitle}
                            isDraggable={isDraggable}
                            isSelected={selectedId === subtitle.id}
                            isEditing={editingId === subtitle.id}
                            onSelect={() => onSelect(subtitle.id)}
                            onEdit={() => onEdit(subtitle.id)}
                            onCommit={(text) => onCommit(subtitle.id, text)}
                            onCancel={onCancel}
                        />
                    );
                })}
            </SortableContext>
        </div>
    );
}

export function TranscriptionViewModal({
    isOpen,
    onClose,
    onApplyGroups
}: TranscriptionViewModalProps) {
    // Persistence State
    const {
        transcriptionGroups,
        transcriptionContainerIds,
        setTranscriptionState
    } = useTimelineStore();

    // Grouping State based on IDs
    const [groups, setGroups] = useState<{ [key: string]: Subtitle[] }>({});
    const [containerIds, setContainerIds] = useState<UniqueIdentifier[]>([]);
    const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);

    // Edit & Select State
    const [selectedId, setSelectedId] = useState<UniqueIdentifier | null>(null);
    const [editingId, setEditingId] = useState<UniqueIdentifier | null>(null);

    // Delete Confirmation
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [itemToDelete, setItemToDelete] = useState<UniqueIdentifier | null>(null);

    // Auto-group popover
    const [showAutoGroup, setShowAutoGroup] = useState(false);
    const [wordsPerLine, setWordsPerLine] = useState(8);
    const [expandedGapIndex, setExpandedGapIndex] = useState<number | null>(null);
    const [recentlyCreatedGroupId, setRecentlyCreatedGroupId] = useState<string | null>(null);
    const autoGroupRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (recentlyCreatedGroupId) {
            const timer = setTimeout(() => {
                setRecentlyCreatedGroupId(null);
            }, 600);
            return () => clearTimeout(timer);
        }
    }, [recentlyCreatedGroupId]);

    // SYNC TO STORE: Keep work-in-progress state in the global store for persistence
    useEffect(() => {
        if (isOpen && Object.keys(groups).length > 0) {
            setTranscriptionState(groups, containerIds.map(id => id.toString()));
        }
    }, [groups, containerIds, isOpen, setTranscriptionState]);

    // Handle clicking outside the auto-group popover
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (autoGroupRef.current && !autoGroupRef.current.contains(event.target as Node)) {
                setShowAutoGroup(false);
            }
        };

        if (showAutoGroup) {
            document.addEventListener('mousedown', handleClickOutside);
        }
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [showAutoGroup]);

    // Initial grouping logic: Load purely from store
    useEffect(() => {
        if (isOpen && Object.keys(groups).length === 0) {
            // Priority 1: Restore existing WIP from store
            if (transcriptionGroups && transcriptionContainerIds) {
                setGroups(transcriptionGroups);
                setContainerIds(transcriptionContainerIds as UniqueIdentifier[]);
                return;
            }

            // Priority 2: Fallback to chunking from Raw Transcription if WIP is missing
            const raw = useTimelineStore.getState().rawTranscription;
            if (raw && raw.length > 0) {
                const { groups: newGroups, containerIds: newIds } =
                    useTimelineStore.getState().generateDefaultGrouperState(raw);
                setGroups(newGroups);
                setContainerIds(newIds as UniqueIdentifier[]);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 8, // Require 8px of movement before drag activates
            },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );

    const isEditing = editingId !== null;

    // KEYBOARD HANDLERS for Global Interactions
    useEffect(() => {
        if (!isOpen) return;

        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            if (isEditing) return;

            if (selectedId) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    setEditingId(selectedId);
                } else if (e.key === 'Escape') {
                    setSelectedId(null);
                } else if (e.key === 'Backspace' || e.key === 'Delete') {
                    e.preventDefault();
                    setItemToDelete(selectedId);
                    setShowDeleteConfirm(true);
                }
            }
        };

        window.addEventListener('keydown', handleGlobalKeyDown);
        return () => window.removeEventListener('keydown', handleGlobalKeyDown);
    }, [isOpen, selectedId, editingId, isEditing]);

    const findContainer = (id: UniqueIdentifier) => {
        if (id in groups) {
            return id;
        }
        return Object.keys(groups).find((key) => groups[key].find((s) => s.id === id));
    };

    const handleDragStart = (event: DragStartEvent) => {
        if (isEditing) return;
        setActiveId(event.active.id);
        setSelectedId(null);
        setExpandedGapIndex(null);
    };

    const handleCommitEdit = (id: string, newText: string) => {
        const trimmed = newText.trim();
        if (!trimmed) {
            setEditingId(null);
            return;
        }

        const containerId = findContainer(id);
        if (!containerId) return;

        const items = groups[containerId];
        const originalIndex = items.findIndex(s => s.id === id);
        if (originalIndex === -1) return;
        const original = items[originalIndex];

        const words = trimmed.split(/\s+/);
        let newSubtitles: Subtitle[] = [];

        if (words.length === 1) {
            newSubtitles = [{ ...original, text: trimmed }];
        } else {
            // SPLIT (Mitosis)
            const totalDuration = original.endTime - original.startTime;
            const portion = totalDuration / words.length;

            newSubtitles = words.map((word, i) => ({
                id: i === 0 ? original.id : crypto.randomUUID(),
                text: word,
                startTime: original.startTime + (i * portion),
                endTime: original.startTime + ((i + 1) * portion)
            }));
        }

        setGroups(prev => {
            const currentGroup = prev[containerId];
            const before = currentGroup.slice(0, originalIndex);
            const after = currentGroup.slice(originalIndex + 1);
            return {
                ...prev,
                [containerId]: [...before, ...newSubtitles, ...after]
            };
        });

        setEditingId(null);
        setSelectedId(null);
    };

    const handleDeleteConfirm = () => {
        if (!itemToDelete) return;

        const containerId = findContainer(itemToDelete);
        if (containerId) {
            setGroups(prev => ({
                ...prev,
                [containerId]: prev[containerId].filter(s => s.id !== itemToDelete)
            }));
        }

        setShowDeleteConfirm(false);
        setItemToDelete(null);
        setSelectedId(null);
    };

    // SACRED ORDER LOGIC
    const isValidMove = (activeId: UniqueIdentifier, sourceContainerId: UniqueIdentifier, targetContainerId: UniqueIdentifier) => {
        const sourceIndex = containerIds.indexOf(sourceContainerId);
        const targetIndex = containerIds.indexOf(targetContainerId);
        const sourceItems = groups[sourceContainerId];

        const isFirstItem = sourceItems[0].id === activeId;
        const isLastItem = sourceItems[sourceItems.length - 1].id === activeId;

        if (isFirstItem && targetIndex < sourceIndex) return true;
        if (isLastItem && targetIndex > sourceIndex) return true;
        if (sourceContainerId === targetContainerId) return false;

        return false;
    };

    const handleDragOver = (event: DragOverEvent) => {
        const { active, over } = event;
        const overId = over?.id;

        if (overId == null || active.id in groups) return;

        // PRIORITIZE GAPS: If we are over a gap or as long as a gap is expanded, 
        // we block any "jump" to join adjacent lines. 
        // This gives the user total control to create new groups.
        if (over?.data.current?.type === 'Gap' || expandedGapIndex !== null) return;

        const overContainer = findContainer(overId);
        const activeContainer = findContainer(active.id);

        if (!over || !overContainer || !activeContainer || activeContainer === overContainer) return;

        // STRICT ADJACENCY CHECK for Group-Group joins
        const activeContainerIndex = containerIds.indexOf(activeContainer);
        const overContainerIndex = over.data.current?.type === 'Gap'
            ? (over.data.current?.index as number)
            : containerIds.indexOf(overContainer);

        if (activeContainerIndex !== -1 && overContainerIndex !== -1) {
            const activeItems = groups[activeContainer];
            const isFirst = activeItems[0].id === active.id;
            const isLast = activeItems[activeItems.length - 1].id === active.id;

            const isNeighborGap = over.data.current?.type === 'Gap' && (
                (isFirst && overContainerIndex === activeContainerIndex) ||
                (isLast && overContainerIndex === activeContainerIndex + 1)
            );

            const isNeighborLine = (over.data.current?.type === 'Line' || over.data.current?.type === 'Sortable') && (
                (isFirst && overContainerIndex === activeContainerIndex - 1) ||
                (isLast && overContainerIndex === activeContainerIndex + 1)
            );

            if (!isNeighborGap && !isNeighborLine) return;
        }

        if (!isValidMove(active.id, activeContainer, overContainer)) return;

        setGroups((prev) => {
            const activeItems = prev[activeContainer];
            const overItems = prev[overContainer];

            const activeIndex = activeItems.findIndex((s) => s.id === active.id);
            const activeContainerIndex = containerIds.indexOf(activeContainer);
            const overContainerIndex = containerIds.indexOf(overContainer);

            const newGroups = { ...prev };
            newGroups[activeContainer] = activeItems.filter(s => s.id !== active.id);

            // Chronological insertion:
            // Moving UP (target < source) -> land at the END of the target
            // Moving DOWN (target > source) -> land at the START of the target
            if (overContainerIndex < activeContainerIndex) {
                newGroups[overContainer] = [...overItems, activeItems[activeIndex]];
            } else {
                newGroups[overContainer] = [activeItems[activeIndex], ...overItems];
            }

            return newGroups;
        });
    };

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        const activeContainer = findContainer(active.id);

        if (!activeContainer) {
            setActiveId(null);
            setExpandedGapIndex(null);
            return;
        }

        const targetGapIndex = (over?.data.current?.type === 'Gap')
            ? over.data.current.index as number
            : expandedGapIndex;

        if (targetGapIndex !== null) {
            const activeItems = groups[activeContainer];
            const isFirst = activeItems[0].id === active.id;
            const isLast = activeItems[activeItems.length - 1].id === active.id;
            const sourceIndex = containerIds.indexOf(activeContainer);

            // DIRECTIONAL CHECK: First only UP (targetGapIndex === sourceIndex), 
            // Last only DOWN (targetGapIndex === sourceIndex + 1)
            if (isFirst && targetGapIndex === sourceIndex) {
                // OK
            } else if (isLast && targetGapIndex === sourceIndex + 1) {
                // OK
            } else {
                setActiveId(null);
                setExpandedGapIndex(null);
                return;
            }

            const movedSubtitle = activeItems.find(s => s.id === active.id);
            if (movedSubtitle) {
                const newGroupId = `group-${Date.now()}`;

                setGroups(prev => ({
                    ...prev,
                    [activeContainer]: prev[activeContainer].filter(s => s.id !== active.id),
                    [newGroupId]: [movedSubtitle]
                }));

                setContainerIds(prev => {
                    const newIds = [...prev];
                    newIds.splice(targetGapIndex, 0, newGroupId);
                    return newIds;
                });

                setRecentlyCreatedGroupId(newGroupId);
                setActiveId(null);
                setExpandedGapIndex(null);
                return;
            }
        }

        setActiveId(null);
        setExpandedGapIndex(null);
    };

    // GAP PRIORITY COLLISION STRATEGY
    const customCollisionDetection: CollisionDetection = (args) => {
        const activeId = args.active.id;
        const activeContainerId = findContainer(activeId);
        if (!activeContainerId) return pointerWithin(args);

        const activeItems = groups[activeContainerId];
        const isFirst = activeItems[0].id === activeId;
        const isLast = activeItems[activeItems.length - 1].id === activeId;
        const activeIndex = containerIds.indexOf(activeContainerId);

        // Filter droppable containers to only allow DIRECTIONAL neighbors
        const neighborContainers = args.droppableContainers.filter(container => {
            const data = container.data.current;
            if (!data) return false;

            if (data.type === 'Gap') {
                const gapIndex = data.index as number;
                // First can only move to GAP ABOVE (gapIndex === activeIndex)
                // Last can only move to GAP BELOW (gapIndex === activeIndex + 1)
                if (isFirst && gapIndex === activeIndex) return true;
                if (isLast && gapIndex === activeIndex + 1) return true;
                return false;
            }

            if (data.type === 'Line') {
                const lineId = container.id;
                const lineIndex = containerIds.indexOf(lineId as string);
                // First can only move to LINE ABOVE (lineIndex === activeIndex - 1)
                // Last can only move to LINE BELOW (lineIndex === activeIndex + 1)
                if (isFirst && lineIndex === activeIndex - 1) return true;
                if (isLast && lineIndex === activeIndex + 1) return true;
                return lineId === activeContainerId; // Keep current for stability
            }

            return false;
        });

        // Prioritize neighbor Gaps
        const gapCollisions = pointerWithin({
            ...args,
            droppableContainers: neighborContainers.filter(c => c.data.current?.type === 'Gap')
        });

        if (gapCollisions.length > 0) return gapCollisions;

        // Fallback to neighbor Lines
        return pointerWithin({
            ...args,
            droppableContainers: neighborContainers.filter(c => c.data.current?.type === 'Line')
        });
    };

    // AUTO-PRUNE & AUTO-SORT EFFECT
    useEffect(() => {
        let changed = false;
        const newGroups = { ...groups };
        let newContainerIds = [...containerIds];

        const emptyIds = newContainerIds.filter(id => newGroups[id] && newGroups[id].length === 0);
        if (emptyIds.length > 0) {
            newContainerIds = newContainerIds.filter(id => !emptyIds.includes(id));
            emptyIds.forEach(id => delete newGroups[id]);
            changed = true;
        }

        Object.keys(newGroups).forEach(key => {
            const currentGroup = newGroups[key];
            const sortedGroup = [...currentGroup].sort((a, b) => a.startTime - b.startTime);
            if (JSON.stringify(currentGroup.map(s => s.id)) !== JSON.stringify(sortedGroup.map(s => s.id))) {
                newGroups[key] = sortedGroup;
                changed = true;
            }
        });

        if (changed) {
            setGroups(newGroups);
            setContainerIds(newContainerIds);
        }
    }, [groups, containerIds]);

    const handleApply = () => {
        const newSubtitles: Subtitle[] = [];
        containerIds.forEach(id => {
            const groupItems = groups[id];
            if (groupItems && groupItems.length > 0) {
                const sortedItems = [...groupItems].sort((a, b) => a.startTime - b.startTime);
                const mergedSub: Subtitle = {
                    id: sortedItems[0].id,
                    startTime: sortedItems[0].startTime,
                    endTime: sortedItems[sortedItems.length - 1].endTime,
                    text: sortedItems.map(s => s.text).join(' ')
                };
                newSubtitles.push(mergedSub);
            }
        });

        // 1. Overwrite Grouper WIP state in store
        setTranscriptionState(groups, containerIds.map(id => id.toString()));

        // 2. Overwrite Timeline track state in store
        onApplyGroups(newSubtitles);

        onClose();
    };

    // AUTO-GROUP: Reset WIP state from Raw Transcription (Rewrites Grouper layer)
    const handleAutoGroup = () => {
        const raw = useTimelineStore.getState().rawTranscription;
        if (!raw || raw.length === 0) return;

        // Reset from Raw (Immutable) with selected words count
        const { groups: newGroups, containerIds: newIds } =
            useTimelineStore.getState().generateDefaultGrouperState(raw, wordsPerLine);

        setGroups(newGroups);
        setContainerIds(newIds as UniqueIdentifier[]);
        setShowAutoGroup(false);
    };

    const allSubtitles = Object.values(groups).flat();
    const activeSubtitle = activeId ? allSubtitles.find(s => s.id === activeId) : null;

    if (!isOpen) return null;

    const dropAnimation: DropAnimation = {
        sideEffects: defaultDropAnimationSideEffects({
            styles: {
                active: { opacity: '0.5' },
            },
        }),
    };

    return (
        <>
            <style dangerouslySetInnerHTML={{
                __html: `
                @keyframes new-group-morph {
                    from { 
                        height: 60px;
                        background-color: rgba(88, 28, 135, 0.4);
                        border-color: rgba(168, 85, 247, 0.6);
                        border-style: dashed;
                        border-width: 2px;
                        box-shadow: 0 0 20px rgba(168, 85, 247, 0.15);
                    }
                    to { 
                        height: auto;
                        min-height: 60px;
                        background-color: rgba(3, 7, 18, 0.5);
                        border-color: rgb(31, 41, 55);
                        border-style: solid;
                        border-width: 1px;
                        box-shadow: 0 0 0px rgba(0, 0, 0, 0);
                    }
                }
            `}} />
            <div
                className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-[100] transition-opacity duration-300"
                onClick={() => {
                    if (isEditing) return;
                    setSelectedId(null);
                    setEditingId(null);
                }}
            >
                <div
                    className="bg-gray-900 border border-gray-700/50 rounded-xl max-w-4xl w-full mx-4 shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 flex flex-col h-[85vh] ring-1 ring-white/10"
                    onClick={e => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className="p-6 pb-4 border-b border-gray-800 flex justify-between items-center bg-gray-900/50">
                        <h2 className="text-xl font-bold flex items-center gap-2">
                            <span className="bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-indigo-500">
                                Agrupador de subtítulos
                            </span>
                        </h2>
                        <div className="flex items-center gap-3">
                            {/* Auto-group button with popover */}
                            <div className="relative" ref={autoGroupRef}>
                                <Button
                                    variant="secondary"
                                    onClick={() => setShowAutoGroup(!showAutoGroup)}
                                    className="bg-gray-800 hover:bg-gray-700 border-gray-700 hover:border-gray-600 transition-all duration-200"
                                >
                                    <Layers className="w-4 h-4 mr-1.5" />
                                    Agrupar
                                </Button>

                                {showAutoGroup && (
                                    <div className="absolute top-full right-0 mt-2 bg-gray-900/95 backdrop-blur-md border border-gray-700 rounded-lg p-5 shadow-2xl z-50 min-w-[240px] animate-in slide-in-from-top-2 duration-200 ring-1 ring-white/10">
                                        <label className="block text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
                                            Palabras por línea
                                        </label>
                                        <input
                                            type="number"
                                            min={1}
                                            max={20}
                                            value={wordsPerLine}
                                            onChange={(e) => setWordsPerLine(Math.max(1, parseInt(e.target.value) || 1))}
                                            className="w-full bg-gray-950 border border-gray-700 rounded-md px-3 py-2 text-white text-sm mb-4 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/50 transition-all"
                                        />
                                        <div className="flex gap-2">
                                            <Button
                                                variant="ghost"
                                                onClick={() => setShowAutoGroup(false)}
                                                className="flex-1 text-gray-400 hover:text-white"
                                            >
                                                Cancelar
                                            </Button>
                                            <Button
                                                variant="primary"
                                                onClick={handleAutoGroup}
                                                className="flex-1"
                                            >
                                                Agrupar
                                            </Button>
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className="w-px h-6 bg-gray-800 mx-1" />

                            <Button
                                variant="ghost"
                                onClick={onClose}
                                className="text-gray-400 hover:text-white"
                            >
                                Cancelar
                            </Button>
                            <Button
                                variant="primary"
                                onClick={handleApply}
                                className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 border-none shadow-lg shadow-blue-900/20 px-6"
                            >
                                Aplicar
                            </Button>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto p-6 bg-gray-950/30 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent">
                        <DndContext
                            sensors={sensors}
                            collisionDetection={customCollisionDetection}
                            onDragStart={handleDragStart}
                            onDragOver={handleDragOver}
                            onDragEnd={handleDragEnd}
                            measuring={{
                                droppable: {
                                    strategy: MeasuringStrategy.Always,
                                }
                            }}
                        >
                            <SortableContext
                                items={containerIds}
                                strategy={verticalListSortingStrategy}
                            >
                                <div className="flex flex-col pb-20">
                                    <DroppableGap
                                        id="gap-start"
                                        index={0}
                                        isExpanded={expandedGapIndex === 0}
                                        isInstant={!!recentlyCreatedGroupId}
                                        onExpandChange={(expanded) => setExpandedGapIndex(expanded ? 0 : (expandedGapIndex === 0 ? null : expandedGapIndex))}
                                    />

                                    {containerIds.map((containerId, index) => (
                                        <React.Fragment key={containerId}>
                                            <DroppableLine
                                                id={containerId}
                                                items={groups[containerId] || []}
                                                selectedId={selectedId}
                                                editingId={editingId}
                                                isRecentlyCreated={recentlyCreatedGroupId === containerId}
                                                onSelect={(id) => {
                                                    if (!isEditing) setSelectedId(id);
                                                }}
                                                onEdit={(id) => {
                                                    setEditingId(id);
                                                }}
                                                onCommit={handleCommitEdit}
                                                onCancel={() => {
                                                    setEditingId(null);
                                                    setSelectedId(null);
                                                }}
                                            />
                                            <DroppableGap
                                                id={`gap-${index + 1}`}
                                                index={index + 1}
                                                isExpanded={expandedGapIndex === index + 1}
                                                isInstant={!!recentlyCreatedGroupId}
                                                onExpandChange={(expanded) => setExpandedGapIndex(expanded ? index + 1 : (expandedGapIndex === index + 1 ? null : expandedGapIndex))}
                                            />
                                        </React.Fragment>
                                    ))}
                                </div>
                            </SortableContext>

                            <DragOverlay dropAnimation={dropAnimation}>
                                {activeId && activeSubtitle ? (
                                    <div className="bg-purple-600 text-white px-3 py-1.5 rounded-full text-sm font-medium shadow-lg ring-2 ring-purple-400 ring-inset scale-105 cursor-grabbing z-50">
                                        {activeSubtitle.text}
                                    </div>
                                ) : null}
                            </DragOverlay>
                        </DndContext>
                    </div>
                </div>
                <ConfirmDialog
                    isOpen={showDeleteConfirm}
                    title="Eliminar palabra"
                    message="¿Estás seguro de que quieres eliminar esta palabra? El tiempo asociado se perderá."
                    confirmLabel="Eliminar"
                    confirmVariant="danger"
                    onConfirm={handleDeleteConfirm}
                    onCancel={() => setShowDeleteConfirm(false)}
                />
            </div>
        </>
    );
}
