export type PropagationEvent = {
  stopPropagation: () => void;
};

export function stopStudentSelectionPropagation(event: PropagationEvent) {
  event.stopPropagation();
}
