import { create } from 'zustand';

type EditorState = {
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
};

export const useEditorStore = create<EditorState>((set) => ({
  selectedNodeId: null,
  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
}));
