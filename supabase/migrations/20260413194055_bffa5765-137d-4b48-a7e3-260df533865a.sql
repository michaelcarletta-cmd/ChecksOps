-- Add SC to state_adoptions for all building code citations that currently have NJ and/or PA
UPDATE building_code_citations 
SET state_adoptions = array_append(state_adoptions, 'SC')
WHERE state_adoptions IS NOT NULL 
  AND NOT ('SC' = ANY(state_adoptions));