import { Typography, Box, Accordion, AccordionSummary, AccordionDetails, List, ListItem, Link, Chip } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import InteractiveCard from './InteractiveCard';
import SentimentNeutralIcon from '@mui/icons-material/SentimentNeutral';
import BalanceIcon from '@mui/icons-material/Balance';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import { submitFeedback } from '../services/api';
import { useState } from 'react';
import ThumbUpIcon from '@mui/icons-material/ThumbUp';
import ThumbDownIcon from '@mui/icons-material/ThumbDown';
import ThumbUpOutlinedIcon from '@mui/icons-material/ThumbUpOutlined';
import ThumbDownOutlinedIcon from '@mui/icons-material/ThumbDownOutlined';

export interface Article {
  id: number;
  title: string;
  link: string;
  source_name: string;
  pub_date: string;
}

export interface Cluster {
  id: number;
  representative_title: string;
  created_at: string;
  articles: Article[];
  summary?: string;
  sentiment?: string;
  focus?: string;
  bias?: string;
  user_feedback?: 'like' | 'dislike' | null;
}

interface ClusterCardProps {
  cluster: Cluster;
}

export default function ClusterCard({ cluster }: ClusterCardProps) {
  const [feedbackState, setFeedbackState] = useState(cluster.user_feedback);
  const sources = [...new Set(cluster.articles.map(a => a.source_name))];

  const sentimentColor = (sentiment?: string) => {
    switch (sentiment) {
      case 'Positiv': return 'success';
      case 'Negativ': return 'error';
      default: return 'default';
    }
  };

  const handleFeedback = async (type: 'like' | 'dislike') => {
    const currentState = feedbackState;
    const newState = currentState === type ? null : type;
    
    setFeedbackState(newState); // Optimistic UI update

    try {
      await submitFeedback(cluster.id, newState);
    } catch (error) {
      console.error(`Failed to submit '${newState}' feedback:`, error);
      setFeedbackState(currentState); // Revert on error
    }
  };

  const likeIcon = feedbackState === 'like' 
    ? <ThumbUpIcon fontSize="small" sx={{ color: 'primary.main' }} /> 
    : <ThumbUpOutlinedIcon fontSize="small" sx={{ color: 'text.secondary' }} />;

  const dislikeIcon = feedbackState === 'dislike'
    ? <ThumbDownIcon fontSize="small" sx={{ color: 'error.main' }} />
    : <ThumbDownOutlinedIcon fontSize="small" sx={{ color: 'text.secondary' }} />;

  return (
    <Box sx={{ mb: 3 }}>
      <InteractiveCard 
        onLike={() => handleFeedback('like')}
        onDislike={() => handleFeedback('dislike')}
        likeIcon={likeIcon}
        dislikeIcon={dislikeIcon}
      >
        <Box sx={{ p: 2.5 }}>
          {/* This content is the same as before */}
          <Typography variant="h6" component="h3" gutterBottom>
            {cluster.representative_title}
          </Typography>
          
          {cluster.summary && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {cluster.summary}
            </Typography>
          )}

          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2, alignItems: 'center' }}>
             {cluster.sentiment && <Chip icon={<SentimentNeutralIcon />} label={cluster.sentiment} size="small" color={sentimentColor(cluster.sentiment)} />}
            {cluster.focus && <Chip icon={<FolderOpenIcon />} label={cluster.focus} size="small" variant="outlined" />}
            {cluster.bias && <Chip icon={<BalanceIcon />} label={cluster.bias} size="small" variant="outlined" />}
             <Box sx={{height: '20px', width: '1px', background: 'divider', mx: 1}} />
            {sources.map(source => (
              <Chip key={source} label={source} size="small" />
            ))}
          </Box>

          <Accordion sx={{ background: 'transparent', boxShadow: 'none', border: '1px solid', borderColor: 'divider', '&:before': { display: 'none' } }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="body2">{`${cluster.articles.length} Artikel anzeigen`}</Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ p: 0, maxHeight: 300, overflowY: 'auto' }}>
              <List dense>
                {cluster.articles.map(article => (
                  <ListItem key={article.id}>
                    <Link href={article.link} target="_blank" rel="noopener noreferrer" sx={{ width: '100%', textDecoration: 'none' }}>
                      <Box sx={{ p: 1, '&:hover': { bgcolor: 'action.hover' }, borderRadius: 1 }}>
                        <Typography variant="body2" component="span" color="text.primary">
                          {article.title}
                        </Typography>
                        <Typography variant="caption" component="div" color="text.secondary">
                          {`${article.source_name} - ${new Date(article.pub_date).toLocaleDateString('de-DE')}`}
                        </Typography>
                      </Box>
                    </Link>
                  </ListItem>
                ))}
              </List>
            </AccordionDetails>
          </Accordion>
        </Box>
      </InteractiveCard>
    </Box>
  );
}
