import { useState, useEffect } from 'react';

export const useMousePosition = (ref: React.RefObject<HTMLElement>) => {
  const [position, setPosition] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (ref.current) {
        const rect = ref.current.getBoundingClientRect();
        setPosition({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      }
    };

    const currentRef = ref.current;
    currentRef?.addEventListener('mousemove', handleMouseMove);

    return () => {
      currentRef?.removeEventListener('mousemove', handleMouseMove);
    };
  }, [ref]);

  return position;
};
