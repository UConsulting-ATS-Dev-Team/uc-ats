import React from 'react';
import { Box, Button, Typography, IconButton, Select, MenuItem, FormControl } from '@mui/material';
import {
  FirstPage as FirstPageIcon,
  LastPage as LastPageIcon,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
} from '@mui/icons-material';

/**
 * Reusable pagination component
 * @param {Object} props
 * @param {number} props.page - Current page (1-indexed)
 * @param {number} props.totalPages - Total number of pages
 * @param {number} props.total - Total number of items
 * @param {number} props.limit - Items per page
 * @param {function} props.onPageChange - Callback when page changes
 * @param {function} props.onLimitChange - Callback when limit changes (optional)
 * @param {boolean} props.loading - Loading state
 * @param {boolean} props.showLimitSelector - Show items per page selector (default: true)
 * @param {number[]} props.limitOptions - Available limit options (default: [25, 50, 100])
 */
export function Pagination({
  page = 1,
  totalPages = 1,
  total = 0,
  limit = 50,
  onPageChange,
  onLimitChange,
  loading = false,
  showLimitSelector = true,
  limitOptions = [10, 25, 50, 100],
}) {
  const handleFirstPage = () => {
    if (page > 1 && !loading) {
      onPageChange(1);
    }
  };

  const handlePrevPage = () => {
    if (page > 1 && !loading) {
      onPageChange(page - 1);
    }
  };

  const handleNextPage = () => {
    if (page < totalPages && !loading) {
      onPageChange(page + 1);
    }
  };

  const handleLastPage = () => {
    if (page < totalPages && !loading) {
      onPageChange(totalPages);
    }
  };

  const handleLimitChange = (event) => {
    if (onLimitChange) {
      onLimitChange(event.target.value);
    }
  };

  // Calculate range of items displayed
  const startItem = total === 0 ? 0 : (page - 1) * limit + 1;
  const endItem = Math.min(page * limit, total);

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        borderTop: '1px solid',
        borderColor: 'divider',
        backgroundColor: 'background.elevated',
        flexWrap: 'wrap',
        gap: 2,
      }}
    >
      {/* Items per page selector */}
      {showLimitSelector && onLimitChange && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="body2" color="textSecondary">
            Items per page:
          </Typography>
          <FormControl size="small" variant="outlined">
            <Select
              value={limit}
              onChange={handleLimitChange}
              disabled={loading}
              sx={{ minWidth: 70 }}
            >
              {limitOptions.map((option) => (
                <MenuItem key={option} value={option}>
                  {option}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>
      )}

      {/* Item range display */}
      <Typography variant="body2" color="textSecondary">
        {total === 0 ? 'No items' : `${startItem}-${endItem} of ${total}`}
      </Typography>

      {/* Page navigation */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <IconButton
          onClick={handleFirstPage}
          disabled={page <= 1 || loading}
          size="small"
          title="First page"
        >
          <FirstPageIcon />
        </IconButton>

        <IconButton
          onClick={handlePrevPage}
          disabled={page <= 1 || loading}
          size="small"
          title="Previous page"
        >
          <ChevronLeftIcon />
        </IconButton>

        <Typography
          variant="body2"
          sx={{ mx: 2, minWidth: '80px', textAlign: 'center' }}
        >
          Page {page} of {totalPages || 1}
        </Typography>

        <IconButton
          onClick={handleNextPage}
          disabled={page >= totalPages || loading}
          size="small"
          title="Next page"
        >
          <ChevronRightIcon />
        </IconButton>

        <IconButton
          onClick={handleLastPage}
          disabled={page >= totalPages || loading}
          size="small"
          title="Last page"
        >
          <LastPageIcon />
        </IconButton>
      </Box>
    </Box>
  );
}

/**
 * Compact pagination for smaller spaces
 */
export function PaginationCompact({
  page = 1,
  totalPages = 1,
  onPageChange,
  loading = false,
}) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <Button
        size="small"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1 || loading}
      >
        Prev
      </Button>
      <Typography variant="body2">
        {page} / {totalPages || 1}
      </Typography>
      <Button
        size="small"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages || loading}
      >
        Next
      </Button>
    </Box>
  );
}

export default Pagination;
