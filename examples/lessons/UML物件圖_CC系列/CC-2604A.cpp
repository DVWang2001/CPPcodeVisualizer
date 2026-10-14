// UML 物件圖教案 CC-2604A：點集合的總和與平均（私有欄位、成員函式讀寫）
// （改寫自 CF 題目 CC-2604A：運算子多載、friend、繼承與 static 改成一般成員函式，才能在瀏覽器引擎逐步執行）
#include<iostream>
#include<vector>
using namespace std;
class Point{
   double m_x,m_y;
public:
   Point(double x=0,double y=0):m_x(x),m_y(y){}
   Point add(Point b){return Point(m_x+b.m_x,m_y+b.m_y);}
   Point div(double b){return Point(m_x/b,m_y/b);}
   void read(){cin>>m_x>>m_y;}
   void print(){cout<<"("<<m_x<<","<<m_y<<")";}
};
class PVec{
   vector<Point> m_pts;
public:
   PVec(int n):m_pts(n){}
   Point sum(){
      Point s;
      for(int k=0;k<m_pts.size();k++) s=s.add(m_pts[k]);
      return s;
   }
   Point avg(){return sum().div(m_pts.size());}
   void read(){for(int k=0;k<m_pts.size();k++) m_pts[k].read();}
   void print(){
      cout<<"sum:";sum().print();cout<<endl;
      cout<<"avg:";avg().print();cout<<endl;
   }
};
int main(){
   int n;cin>>n;
   PVec pts(n);
   pts.read();
   pts.print();  //@ @guide uml:pts
   return 0;
}
