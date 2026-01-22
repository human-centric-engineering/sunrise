/**
 * Table Component Tests
 *
 * Tests the Table components (shadcn/ui wrappers for native HTML table elements):
 * - Table: Wrapper with overflow-auto container
 * - TableHeader: thead with border styling
 * - TableBody: tbody with last row border removal
 * - TableFooter: tfoot with muted background
 * - TableHead: th with left alignment and muted text
 * - TableRow: tr with hover and selection states
 * - TableCell: td with padding and alignment
 * - TableCaption: caption with muted text
 *
 * Test Coverage:
 * - Rendering with correct semantic HTML elements
 * - className prop merging with default styles
 * - Ref forwarding to underlying elements
 * - Props spreading to elements
 * - Default styling classes
 * - Integration with full table structure
 * - Accessibility (proper HTML semantics)
 *
 * Note: These are thin wrappers around native HTML elements. Tests focus on
 * className merging, ref forwarding, and ensuring semantic HTML is correct.
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/ui/table.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from '@/components/ui/table';

/**
 * Test Suite: Table Components
 *
 * Tests the table components with focus on semantic HTML and styling.
 */
describe('components/ui/table', () => {
  describe('Table', () => {
    describe('rendering', () => {
      it('should render without crashing', () => {
        // Arrange & Act
        const { container } = render(<Table />);

        // Assert: Should render
        expect(container.firstChild).toBeInTheDocument();
      });

      it('should render as a table element inside a wrapper div', () => {
        // Arrange & Act
        const { container } = render(<Table />);

        // Assert: Should have wrapper div and table element
        const wrapper = container.firstChild;
        const table = wrapper?.firstChild;
        expect(wrapper?.nodeName).toBe('DIV');
        expect(table?.nodeName).toBe('TABLE');
      });

      it('should render children', () => {
        // Arrange & Act
        render(
          <Table>
            <TableBody>
              <TableRow>
                <TableCell>Content</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        );

        // Assert: Children should be rendered
        expect(screen.getByText('Content')).toBeInTheDocument();
      });
    });

    describe('className prop', () => {
      it('should apply default styling classes to table', () => {
        // Arrange & Act
        const { container } = render(<Table />);

        // Assert: Table should have default classes
        const table = container.querySelector('table');
        expect(table).toHaveClass('w-full');
        expect(table).toHaveClass('caption-bottom');
        expect(table).toHaveClass('text-sm');
      });

      it('should apply default wrapper classes', () => {
        // Arrange & Act
        const { container } = render(<Table />);

        // Assert: Wrapper should have overflow and width classes
        const wrapper = container.firstChild as HTMLElement;
        expect(wrapper).toHaveClass('relative');
        expect(wrapper).toHaveClass('w-full');
        expect(wrapper).toHaveClass('overflow-auto');
      });

      it('should apply custom className to table', () => {
        // Arrange & Act
        const { container } = render(<Table className="custom-table" />);

        // Assert: Custom class should be on table element
        const table = container.querySelector('table');
        expect(table).toHaveClass('custom-table');
        expect(table).toHaveClass('w-full');
      });

      it('should merge multiple custom classes', () => {
        // Arrange & Act
        const { container } = render(<Table className="custom-1 custom-2 custom-3" />);

        // Assert: All custom classes should be present
        const table = container.querySelector('table');
        expect(table).toHaveClass('custom-1');
        expect(table).toHaveClass('custom-2');
        expect(table).toHaveClass('custom-3');
      });

      it('should handle undefined className gracefully', () => {
        // Arrange & Act
        const { container } = render(<Table className={undefined} />);

        // Assert: Should render with default classes
        const table = container.querySelector('table');
        expect(table).toHaveClass('w-full');
      });

      it('should handle empty string className', () => {
        // Arrange & Act
        const { container } = render(<Table className="" />);

        // Assert: Should render with default classes
        const table = container.querySelector('table');
        expect(table).toHaveClass('w-full');
      });
    });

    describe('ref forwarding', () => {
      it('should forward ref to table element', () => {
        // Arrange
        const ref = createRef<HTMLTableElement>();

        // Act
        render(<Table ref={ref} />);

        // Assert: Ref should point to table element
        expect(ref.current).toBeInstanceOf(HTMLTableElement);
        expect(ref.current?.tagName).toBe('TABLE');
      });

      it('should allow calling methods on forwarded ref', () => {
        // Arrange
        const ref = createRef<HTMLTableElement>();
        render(<Table ref={ref} />);

        // Act: Access ref properties
        const tagName = ref.current?.tagName;
        const hasClass = ref.current?.classList.contains('w-full');

        // Assert: Should have correct properties
        expect(tagName).toBe('TABLE');
        expect(hasClass).toBe(true);
      });
    });

    describe('props spreading', () => {
      it('should spread additional props to table element', () => {
        // Arrange & Act
        const { container } = render(<Table data-testid="custom-table" aria-label="Data table" />);

        // Assert: Props should be applied to table
        const table = container.querySelector('table');
        expect(table).toHaveAttribute('data-testid', 'custom-table');
        expect(table).toHaveAttribute('aria-label', 'Data table');
      });

      it('should handle id prop', () => {
        // Arrange & Act
        const { container } = render(<Table id="my-table" />);

        // Assert: Should have id attribute on table
        const table = container.querySelector('table');
        expect(table).toHaveAttribute('id', 'my-table');
      });

      it('should handle data attributes', () => {
        // Arrange & Act
        const { container } = render(
          <Table data-section="users" data-index="1" data-sortable="true" />
        );

        // Assert: Should have all data attributes
        const table = container.querySelector('table');
        expect(table).toHaveAttribute('data-section', 'users');
        expect(table).toHaveAttribute('data-index', '1');
        expect(table).toHaveAttribute('data-sortable', 'true');
      });
    });
  });

  describe('TableHeader', () => {
    describe('rendering', () => {
      it('should render as thead element', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableHeader />
          </Table>
        );

        // Assert: Should be thead element
        const thead = container.querySelector('thead');
        expect(thead).toBeInTheDocument();
      });

      it('should render children', () => {
        // Arrange & Act
        render(
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Header</TableHead>
              </TableRow>
            </TableHeader>
          </Table>
        );

        // Assert: Children should be rendered
        expect(screen.getByText('Header')).toBeInTheDocument();
      });
    });

    describe('className prop', () => {
      it('should apply default styling classes', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableHeader />
          </Table>
        );

        // Assert: Should have border styling
        const thead = container.querySelector('thead');
        expect(thead).toHaveClass('[&_tr]:border-b');
      });

      it('should apply custom className', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableHeader className="custom-header" />
          </Table>
        );

        // Assert: Custom class should be applied
        const thead = container.querySelector('thead');
        expect(thead).toHaveClass('custom-header');
        expect(thead).toHaveClass('[&_tr]:border-b');
      });
    });

    describe('ref forwarding', () => {
      it('should forward ref to thead element', () => {
        // Arrange
        const ref = createRef<HTMLTableSectionElement>();

        // Act
        render(
          <Table>
            <TableHeader ref={ref} />
          </Table>
        );

        // Assert: Ref should point to thead element
        expect(ref.current).toBeInstanceOf(HTMLTableSectionElement);
        expect(ref.current?.tagName).toBe('THEAD');
      });
    });

    describe('props spreading', () => {
      it('should spread additional props', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableHeader data-testid="table-header" />
          </Table>
        );

        // Assert: Props should be applied
        const thead = container.querySelector('thead');
        expect(thead).toHaveAttribute('data-testid', 'table-header');
      });
    });
  });

  describe('TableBody', () => {
    describe('rendering', () => {
      it('should render as tbody element', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableBody />
          </Table>
        );

        // Assert: Should be tbody element
        const tbody = container.querySelector('tbody');
        expect(tbody).toBeInTheDocument();
      });

      it('should render children', () => {
        // Arrange & Act
        render(
          <Table>
            <TableBody>
              <TableRow>
                <TableCell>Body Content</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        );

        // Assert: Children should be rendered
        expect(screen.getByText('Body Content')).toBeInTheDocument();
      });
    });

    describe('className prop', () => {
      it('should apply default styling classes', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableBody />
          </Table>
        );

        // Assert: Should have last row border removal class
        const tbody = container.querySelector('tbody');
        expect(tbody).toHaveClass('[&_tr:last-child]:border-0');
      });

      it('should apply custom className', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableBody className="custom-body" />
          </Table>
        );

        // Assert: Custom class should be applied
        const tbody = container.querySelector('tbody');
        expect(tbody).toHaveClass('custom-body');
        expect(tbody).toHaveClass('[&_tr:last-child]:border-0');
      });
    });

    describe('ref forwarding', () => {
      it('should forward ref to tbody element', () => {
        // Arrange
        const ref = createRef<HTMLTableSectionElement>();

        // Act
        render(
          <Table>
            <TableBody ref={ref} />
          </Table>
        );

        // Assert: Ref should point to tbody element
        expect(ref.current).toBeInstanceOf(HTMLTableSectionElement);
        expect(ref.current?.tagName).toBe('TBODY');
      });
    });

    describe('props spreading', () => {
      it('should spread additional props', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableBody data-testid="table-body" />
          </Table>
        );

        // Assert: Props should be applied
        const tbody = container.querySelector('tbody');
        expect(tbody).toHaveAttribute('data-testid', 'table-body');
      });
    });
  });

  describe('TableFooter', () => {
    describe('rendering', () => {
      it('should render as tfoot element', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableFooter />
          </Table>
        );

        // Assert: Should be tfoot element
        const tfoot = container.querySelector('tfoot');
        expect(tfoot).toBeInTheDocument();
      });

      it('should render children', () => {
        // Arrange & Act
        render(
          <Table>
            <TableFooter>
              <TableRow>
                <TableCell>Footer Content</TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        );

        // Assert: Children should be rendered
        expect(screen.getByText('Footer Content')).toBeInTheDocument();
      });
    });

    describe('className prop', () => {
      it('should apply default styling classes', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableFooter />
          </Table>
        );

        // Assert: Should have footer styling
        const tfoot = container.querySelector('tfoot');
        expect(tfoot).toHaveClass('bg-muted/50');
        expect(tfoot).toHaveClass('border-t');
        expect(tfoot).toHaveClass('font-medium');
        expect(tfoot).toHaveClass('[&>tr]:last:border-b-0');
      });

      it('should apply custom className', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableFooter className="custom-footer" />
          </Table>
        );

        // Assert: Custom class should be applied
        const tfoot = container.querySelector('tfoot');
        expect(tfoot).toHaveClass('custom-footer');
        expect(tfoot).toHaveClass('bg-muted/50');
      });
    });

    describe('ref forwarding', () => {
      it('should forward ref to tfoot element', () => {
        // Arrange
        const ref = createRef<HTMLTableSectionElement>();

        // Act
        render(
          <Table>
            <TableFooter ref={ref} />
          </Table>
        );

        // Assert: Ref should point to tfoot element
        expect(ref.current).toBeInstanceOf(HTMLTableSectionElement);
        expect(ref.current?.tagName).toBe('TFOOT');
      });
    });

    describe('props spreading', () => {
      it('should spread additional props', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableFooter data-testid="table-footer" />
          </Table>
        );

        // Assert: Props should be applied
        const tfoot = container.querySelector('tfoot');
        expect(tfoot).toHaveAttribute('data-testid', 'table-footer');
      });
    });
  });

  describe('TableRow', () => {
    describe('rendering', () => {
      it('should render as tr element', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableBody>
              <TableRow />
            </TableBody>
          </Table>
        );

        // Assert: Should be tr element
        const tr = container.querySelector('tr');
        expect(tr).toBeInTheDocument();
      });

      it('should render children', () => {
        // Arrange & Act
        render(
          <Table>
            <TableBody>
              <TableRow>
                <TableCell>Row Content</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        );

        // Assert: Children should be rendered
        expect(screen.getByText('Row Content')).toBeInTheDocument();
      });
    });

    describe('className prop', () => {
      it('should apply default styling classes', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableBody>
              <TableRow />
            </TableBody>
          </Table>
        );

        // Assert: Should have row styling
        const tr = container.querySelector('tr');
        expect(tr).toHaveClass('hover:bg-muted/50');
        expect(tr).toHaveClass('data-[state=selected]:bg-muted');
        expect(tr).toHaveClass('border-b');
        expect(tr).toHaveClass('transition-colors');
      });

      it('should apply custom className', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableBody>
              <TableRow className="custom-row" />
            </TableBody>
          </Table>
        );

        // Assert: Custom class should be applied
        const tr = container.querySelector('tr');
        expect(tr).toHaveClass('custom-row');
        expect(tr).toHaveClass('border-b');
      });
    });

    describe('ref forwarding', () => {
      it('should forward ref to tr element', () => {
        // Arrange
        const ref = createRef<HTMLTableRowElement>();

        // Act
        render(
          <Table>
            <TableBody>
              <TableRow ref={ref} />
            </TableBody>
          </Table>
        );

        // Assert: Ref should point to tr element
        expect(ref.current).toBeInstanceOf(HTMLTableRowElement);
        expect(ref.current?.tagName).toBe('TR');
      });
    });

    describe('props spreading', () => {
      it('should spread additional props', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableBody>
              <TableRow data-testid="table-row" />
            </TableBody>
          </Table>
        );

        // Assert: Props should be applied
        const tr = container.querySelector('tr');
        expect(tr).toHaveAttribute('data-testid', 'table-row');
      });

      it('should handle data-state attribute for selection', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableBody>
              <TableRow data-state="selected" />
            </TableBody>
          </Table>
        );

        // Assert: data-state should be applied
        const tr = container.querySelector('tr');
        expect(tr).toHaveAttribute('data-state', 'selected');
      });
    });
  });

  describe('TableHead', () => {
    describe('rendering', () => {
      it('should render as th element', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead />
              </TableRow>
            </TableHeader>
          </Table>
        );

        // Assert: Should be th element
        const th = container.querySelector('th');
        expect(th).toBeInTheDocument();
      });

      it('should render children', () => {
        // Arrange & Act
        render(
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Column Header</TableHead>
              </TableRow>
            </TableHeader>
          </Table>
        );

        // Assert: Children should be rendered
        expect(screen.getByText('Column Header')).toBeInTheDocument();
      });
    });

    describe('className prop', () => {
      it('should apply default styling classes', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead />
              </TableRow>
            </TableHeader>
          </Table>
        );

        // Assert: Should have header cell styling
        const th = container.querySelector('th');
        expect(th).toHaveClass('text-muted-foreground');
        expect(th).toHaveClass('h-10');
        expect(th).toHaveClass('px-2');
        expect(th).toHaveClass('text-left');
        expect(th).toHaveClass('align-middle');
        expect(th).toHaveClass('font-medium');
        expect(th).toHaveClass('[&:has([role=checkbox])]:pr-0');
        expect(th).toHaveClass('[&>[role=checkbox]]:translate-y-[2px]');
      });

      it('should apply custom className', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="custom-head" />
              </TableRow>
            </TableHeader>
          </Table>
        );

        // Assert: Custom class should be applied
        const th = container.querySelector('th');
        expect(th).toHaveClass('custom-head');
        expect(th).toHaveClass('text-muted-foreground');
      });
    });

    describe('ref forwarding', () => {
      it('should forward ref to th element', () => {
        // Arrange
        const ref = createRef<HTMLTableCellElement>();

        // Act
        render(
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead ref={ref} />
              </TableRow>
            </TableHeader>
          </Table>
        );

        // Assert: Ref should point to th element
        expect(ref.current).toBeInstanceOf(HTMLTableCellElement);
        expect(ref.current?.tagName).toBe('TH');
      });
    });

    describe('props spreading', () => {
      it('should spread additional props', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead data-testid="table-head" aria-sort="ascending" />
              </TableRow>
            </TableHeader>
          </Table>
        );

        // Assert: Props should be applied
        const th = container.querySelector('th');
        expect(th).toHaveAttribute('data-testid', 'table-head');
        expect(th).toHaveAttribute('aria-sort', 'ascending');
      });

      it('should handle scope attribute', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col" />
              </TableRow>
            </TableHeader>
          </Table>
        );

        // Assert: scope should be applied
        const th = container.querySelector('th');
        expect(th).toHaveAttribute('scope', 'col');
      });
    });
  });

  describe('TableCell', () => {
    describe('rendering', () => {
      it('should render as td element', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableBody>
              <TableRow>
                <TableCell />
              </TableRow>
            </TableBody>
          </Table>
        );

        // Assert: Should be td element
        const td = container.querySelector('td');
        expect(td).toBeInTheDocument();
      });

      it('should render children', () => {
        // Arrange & Act
        render(
          <Table>
            <TableBody>
              <TableRow>
                <TableCell>Cell Content</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        );

        // Assert: Children should be rendered
        expect(screen.getByText('Cell Content')).toBeInTheDocument();
      });
    });

    describe('className prop', () => {
      it('should apply default styling classes', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableBody>
              <TableRow>
                <TableCell />
              </TableRow>
            </TableBody>
          </Table>
        );

        // Assert: Should have cell styling
        const td = container.querySelector('td');
        expect(td).toHaveClass('p-2');
        expect(td).toHaveClass('align-middle');
        expect(td).toHaveClass('[&:has([role=checkbox])]:pr-0');
        expect(td).toHaveClass('[&>[role=checkbox]]:translate-y-[2px]');
      });

      it('should apply custom className', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableBody>
              <TableRow>
                <TableCell className="custom-cell" />
              </TableRow>
            </TableBody>
          </Table>
        );

        // Assert: Custom class should be applied
        const td = container.querySelector('td');
        expect(td).toHaveClass('custom-cell');
        expect(td).toHaveClass('p-2');
      });
    });

    describe('ref forwarding', () => {
      it('should forward ref to td element', () => {
        // Arrange
        const ref = createRef<HTMLTableCellElement>();

        // Act
        render(
          <Table>
            <TableBody>
              <TableRow>
                <TableCell ref={ref} />
              </TableRow>
            </TableBody>
          </Table>
        );

        // Assert: Ref should point to td element
        expect(ref.current).toBeInstanceOf(HTMLTableCellElement);
        expect(ref.current?.tagName).toBe('TD');
      });
    });

    describe('props spreading', () => {
      it('should spread additional props', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableBody>
              <TableRow>
                <TableCell data-testid="table-cell" />
              </TableRow>
            </TableBody>
          </Table>
        );

        // Assert: Props should be applied
        const td = container.querySelector('td');
        expect(td).toHaveAttribute('data-testid', 'table-cell');
      });

      it('should handle colSpan attribute', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableBody>
              <TableRow>
                <TableCell colSpan={2} />
              </TableRow>
            </TableBody>
          </Table>
        );

        // Assert: colSpan should be applied
        const td = container.querySelector('td');
        expect(td).toHaveAttribute('colspan', '2');
      });
    });
  });

  describe('TableCaption', () => {
    describe('rendering', () => {
      it('should render as caption element', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableCaption />
          </Table>
        );

        // Assert: Should be caption element
        const caption = container.querySelector('caption');
        expect(caption).toBeInTheDocument();
      });

      it('should render children', () => {
        // Arrange & Act
        render(
          <Table>
            <TableCaption>Table Description</TableCaption>
          </Table>
        );

        // Assert: Children should be rendered
        expect(screen.getByText('Table Description')).toBeInTheDocument();
      });
    });

    describe('className prop', () => {
      it('should apply default styling classes', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableCaption />
          </Table>
        );

        // Assert: Should have caption styling
        const caption = container.querySelector('caption');
        expect(caption).toHaveClass('text-muted-foreground');
        expect(caption).toHaveClass('mt-4');
        expect(caption).toHaveClass('text-sm');
      });

      it('should apply custom className', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableCaption className="custom-caption" />
          </Table>
        );

        // Assert: Custom class should be applied
        const caption = container.querySelector('caption');
        expect(caption).toHaveClass('custom-caption');
        expect(caption).toHaveClass('text-muted-foreground');
      });
    });

    describe('ref forwarding', () => {
      it('should forward ref to caption element', () => {
        // Arrange
        const ref = createRef<HTMLTableCaptionElement>();

        // Act
        render(
          <Table>
            <TableCaption ref={ref} />
          </Table>
        );

        // Assert: Ref should point to caption element
        expect(ref.current).toBeInstanceOf(HTMLTableCaptionElement);
        expect(ref.current?.tagName).toBe('CAPTION');
      });
    });

    describe('props spreading', () => {
      it('should spread additional props', () => {
        // Arrange & Act
        const { container } = render(
          <Table>
            <TableCaption data-testid="table-caption" />
          </Table>
        );

        // Assert: Props should be applied
        const caption = container.querySelector('caption');
        expect(caption).toHaveAttribute('data-testid', 'table-caption');
      });
    });
  });

  describe('integration and composition', () => {
    it('should render complete table with all components', () => {
      // Arrange & Act
      render(
        <Table>
          <TableCaption>User List</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>John Doe</TableCell>
              <TableCell>john@example.com</TableCell>
              <TableCell>Admin</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Jane Smith</TableCell>
              <TableCell>jane@example.com</TableCell>
              <TableCell>User</TableCell>
            </TableRow>
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={3}>Total: 2 users</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      );

      // Assert: All content should be present
      expect(screen.getByText('User List')).toBeInTheDocument();
      expect(screen.getByText('Name')).toBeInTheDocument();
      expect(screen.getByText('Email')).toBeInTheDocument();
      expect(screen.getByText('Role')).toBeInTheDocument();
      expect(screen.getByText('John Doe')).toBeInTheDocument();
      expect(screen.getByText('john@example.com')).toBeInTheDocument();
      expect(screen.getByText('Admin')).toBeInTheDocument();
      expect(screen.getByText('Jane Smith')).toBeInTheDocument();
      expect(screen.getByText('jane@example.com')).toBeInTheDocument();
      expect(screen.getByText('User')).toBeInTheDocument();
      expect(screen.getByText('Total: 2 users')).toBeInTheDocument();
    });

    it('should render minimal table with just header and body', () => {
      // Arrange & Act
      render(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Column</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Data</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );

      // Assert: Content should be present
      expect(screen.getByText('Column')).toBeInTheDocument();
      expect(screen.getByText('Data')).toBeInTheDocument();
    });

    it('should handle multiple rows in body', () => {
      // Arrange & Act
      const { container } = render(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>Row 1</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Row 2</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Row 3</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );

      // Assert: All rows should be present
      const rows = container.querySelectorAll('tbody tr');
      expect(rows).toHaveLength(3);
      expect(screen.getByText('Row 1')).toBeInTheDocument();
      expect(screen.getByText('Row 2')).toBeInTheDocument();
      expect(screen.getByText('Row 3')).toBeInTheDocument();
    });

    it('should handle multiple columns', () => {
      // Arrange & Act
      const { container } = render(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Col 1</TableHead>
              <TableHead>Col 2</TableHead>
              <TableHead>Col 3</TableHead>
            </TableRow>
          </TableHeader>
        </Table>
      );

      // Assert: All columns should be present
      const headers = container.querySelectorAll('th');
      expect(headers).toHaveLength(3);
    });
  });

  describe('accessibility', () => {
    it('should use semantic HTML table elements', () => {
      // Arrange & Act
      const { container } = render(
        <Table>
          <TableCaption>Accessible Table</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Header</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Data</TableCell>
            </TableRow>
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell>Footer</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      );

      // Assert: All semantic elements should be present
      expect(container.querySelector('table')).toBeInTheDocument();
      expect(container.querySelector('caption')).toBeInTheDocument();
      expect(container.querySelector('thead')).toBeInTheDocument();
      expect(container.querySelector('tbody')).toBeInTheDocument();
      expect(container.querySelector('tfoot')).toBeInTheDocument();
      expect(container.querySelector('th')).toBeInTheDocument();
      expect(container.querySelector('td')).toBeInTheDocument();
    });

    it('should support aria-label on table', () => {
      // Arrange & Act
      const { container } = render(<Table aria-label="User data table" />);

      // Assert: aria-label should be applied
      const table = container.querySelector('table');
      expect(table).toHaveAttribute('aria-label', 'User data table');
    });

    it('should support scope attribute on headers', () => {
      // Arrange & Act
      const { container } = render(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Email</TableHead>
            </TableRow>
          </TableHeader>
        </Table>
      );

      // Assert: scope attributes should be applied
      const headers = container.querySelectorAll('th');
      expect(headers[0]).toHaveAttribute('scope', 'col');
      expect(headers[1]).toHaveAttribute('scope', 'col');
    });

    it('should position caption correctly with caption-bottom class', () => {
      // Arrange & Act
      const { container } = render(
        <Table>
          <TableCaption>This caption appears at the bottom</TableCaption>
        </Table>
      );

      // Assert: Table should have caption-bottom class
      const table = container.querySelector('table');
      expect(table).toHaveClass('caption-bottom');
    });
  });

  describe('edge cases', () => {
    it('should render empty table', () => {
      // Arrange & Act
      const { container } = render(<Table />);

      // Assert: Should render without errors
      const table = container.querySelector('table');
      expect(table).toBeInTheDocument();
    });

    it('should handle table with only caption', () => {
      // Arrange & Act
      render(
        <Table>
          <TableCaption>Only Caption</TableCaption>
        </Table>
      );

      // Assert: Should render without errors
      expect(screen.getByText('Only Caption')).toBeInTheDocument();
    });

    it('should handle undefined className on all components', () => {
      // Arrange & Act
      render(
        <Table className={undefined}>
          <TableCaption className={undefined}>Caption</TableCaption>
          <TableHeader className={undefined}>
            <TableRow className={undefined}>
              <TableHead className={undefined}>Header</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className={undefined}>
            <TableRow className={undefined}>
              <TableCell className={undefined}>Cell</TableCell>
            </TableRow>
          </TableBody>
          <TableFooter className={undefined}>
            <TableRow className={undefined}>
              <TableCell className={undefined}>Footer</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      );

      // Assert: Should render without errors
      expect(screen.getByText('Caption')).toBeInTheDocument();
      expect(screen.getByText('Header')).toBeInTheDocument();
      expect(screen.getByText('Cell')).toBeInTheDocument();
      expect(screen.getByText('Footer')).toBeInTheDocument();
    });

    it('should handle empty string className on all components', () => {
      // Arrange & Act
      render(
        <Table className="">
          <TableCaption className="">Caption</TableCaption>
          <TableHeader className="">
            <TableRow className="">
              <TableHead className="">Header</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="">
            <TableRow className="">
              <TableCell className="">Cell</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );

      // Assert: Should render without errors
      expect(screen.getByText('Caption')).toBeInTheDocument();
      expect(screen.getByText('Header')).toBeInTheDocument();
      expect(screen.getByText('Cell')).toBeInTheDocument();
    });
  });
});
