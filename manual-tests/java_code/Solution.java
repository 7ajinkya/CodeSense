package java_code;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.util.StringTokenizer;

final class Solution {
    private Solution() {}
    private static void dfs(int r,int c, char[][] g, boolean[][] vis){
        int n = g.length;
        int m = g[0].length;
        if (r < 0 || r >= n || c < 0 || c >= m) {
            return;
        }
        if (vis[r][c] || g[r][c] != '.') {
            return;
        }
        vis[r][c] = true;
        dfs(r+1,c,g,vis); 
        dfs(r-1,c,g,vis); 
        dfs(r,c+1,g,vis); 
        dfs(r,c-1,g,vis);
    }
    public static void main(String[] args) throws IOException {
        try(BufferedReader br=new BufferedReader(new InputStreamReader(System.in));) {
            StringTokenizer st=new StringTokenizer(br.readLine());
            int n=Integer.parseInt(st.nextToken());
            int m=Integer.parseInt(st.nextToken());
            char[][] grid=new char[n][m];
            for(int i=0;i<n;i++){
                String line=br.readLine();
                grid[i]=line.toCharArray();
            }
            boolean[][] vis=new boolean[n][m];
            int rooms=0;
            for(int i=0;i<n;i++){
                for(int j=0;j<m;j++){
                    if(!vis[i][j] && grid[i][j] == '.') {
                        dfs(i,j,grid,vis);
                        rooms+=1;
                    }
                }
            }
            System.out.println(rooms);
        }
    }
}