# we can find the size of each connected component and then 
# find the biggest of them all by maintaining a global max

def largestConnectedRegion(grid: list[list[int]]) -> int:
    rows,cols=len(grid),len(grid[0])
    best_connected_region=0
    def dfs(x,y):
        size=1
        for nx, ny in [(x+1,y),(x-1,y),(x,y+1),(x,y-1)]:
            if 0<=nx<rows and 0<=ny<cols and grid[nx][ny]==1:
                grid[nx][ny]=0
                size+=dfs(nx,ny)
        return size
    for i in range(rows):
        for j in range(cols):
            if grid[i][j]==1:
                grid[i][j]=0
                best_connected_region=max(best_connected_region, dfs(i,j))
    return best_connected_region

grid = [[0,0,1,0,0,0,0,1,0,0,0,0,0],
               [0,0,0,0,0,0,0,1,1,1,0,0,0],
               [0,1,1,0,1,0,0,0,0,0,0,0,0],
               [0,1,0,0,1,1,0,0,1,0,1,0,0],
               [0,1,0,0,1,1,0,0,1,1,1,0,0],
               [0,0,0,0,0,0,0,0,0,0,1,0,0],
               [0,0,0,0,0,0,0,1,1,1,0,0,0],
               [0,0,0,0,0,0,0,1,1,0,0,0,0]]
print(largestConnectedRegion(grid))