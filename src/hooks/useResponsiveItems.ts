import { useState, useEffect } from 'react';

export function useResponsiveItems() {
  const [itemCount, setItemCount] = useState(5);

  useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth;
      // Breakpoints match Tailwind: md = 768px, lg = 1024px
      if (width >= 1024) {
        setItemCount(5);
      } else if (width >= 768) {
        setItemCount(4);
      } else {
        setItemCount(2);
      }
    };

    handleResize(); // Initial call
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return itemCount;
}
